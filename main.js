const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist');
const { PDFDocument } = require('pdf-lib');
const { parseStringPromise, Builder } = require('xml2js');


async function extractZugferdXmlFromPdf(inputPdfPath) 
{
	const pdfData = new Uint8Array(fs.readFileSync(inputPdfPath));
	const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;

	let xmlContent = null;

	const attachments = await pdfDoc.getAttachments();
	if (!attachments) {
		throw new Error('No ZUGFeRD XML file found in the PDF.');
	}

	const names = Object.getOwnPropertyNames(attachments);
	let xmlFileName = '';

	for (const name of names) {

		if (!name.toLowerCase().endsWith('.xml')) {
			continue;
		}

		const attachment = attachments[name];
		xmlFileName = name;

		const embeddedFileData = attachment.content;
		xmlContent = Buffer.from(embeddedFileData).toString('utf8');
		break;
	}

	if (!xmlContent) {
		throw new Error('No ZUGFeRD XML file found in the PDF.');
	}

	return {xml: xmlContent, filename: xmlFileName};
}


async function modifyXmlContent(xmlObj) 
{	
	// Namespace shortcuts
	const rsm = xmlObj['rsm:CrossIndustryInvoice'];
	const tradeTransaction = rsm['rsm:SupplyChainTradeTransaction'][0];
	const headerAgreement = tradeTransaction['ram:ApplicableHeaderTradeAgreement'][0];
	const sellerTradeParty = headerAgreement['ram:SellerTradeParty'][0];
	const buyerTradeParty = headerAgreement['ram:BuyerTradeParty'][0];
	let exchangedDocumentContext = rsm['rsm:ExchangedDocumentContext'][0];


	// Otherwise raises WARNING  PEPPOL-EN1631-R10: Buyer electronic address MUST be provided, Fakturama does not do this from the contact email
	//
	buyerTradeParty['ram:URIUniversalCommunication'] = [
		{
			'ram:URIID': [
				{
					_: 'noreply@something.com',
					$: { schemeID: 'EM' },
				},
			],
		},
	];

	// Otherwise raises validation WARNING PEPPOL-EN16931-R001: Ensure to add that business process (BT-23) if not present
	//
	if (!exchangedDocumentContext['ram:BusinessProcessSpecifiedDocumentContextParameter']) {
		// Erstelle das neue Element
		let newBusinessProcess = [
			{
				'ram:ID': ['urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'],
			},
		];
	
		// Verschiebe das neue Element an den Anfang der Objekte
		rsm['rsm:ExchangedDocumentContext'][0] = {
			'ram:BusinessProcessSpecifiedDocumentContextParameter': newBusinessProcess,
			...exchangedDocumentContext,
		};
	}

	// Otherwise raises validation WARNING [BR-DE-21] Das Element "Specification identifier" (BT-24) soll syntaktisch der Kennung des Standards XRechnung entsprechen.
	//
	const specificationIdentifier = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';
	const exchangedDocumentContext1 = rsm['rsm:ExchangedDocumentContext'][0];
	exchangedDocumentContext1['ram:GuidelineSpecifiedDocumentContextParameter'][0]['ram:ID'][0] = specificationIdentifier;

	// Otherweise throws WARNING for empty elements: Remove empty "ram:GlobalID" node
	if (sellerTradeParty['ram:GlobalID'] && !sellerTradeParty['ram:GlobalID'][0]._) {
		delete sellerTradeParty['ram:GlobalID'];
	}

	// Otherweise throws WARNING for empty elements: Remove "ram:SpecifiedLegalOrganization" if "ram:ID" is empty
	if (sellerTradeParty['ram:SpecifiedLegalOrganization'] &&
		!sellerTradeParty['ram:SpecifiedLegalOrganization'][0]['ram:ID'][0]) {
		delete sellerTradeParty['ram:SpecifiedLegalOrganization'];
	}
	

	//
	// These items would cause validation ERRORS
	//


	// Bug in Fakturama 2.1.3-SNAPSHOT, small businesses without VAT ID must set FC type tax registration number
	//
	sellerTradeParty['ram:SpecifiedTaxRegistration'][0]['ram:ID'][0].$.schemeID = 'FC';


	// Otherweise validation ERROR: Synchronize values for specific XPath nodes (TAX amounts)
	// 
	const tradeSettlement = tradeTransaction['ram:ApplicableHeaderTradeSettlement'][0];

	const tradeTax = tradeSettlement['ram:ApplicableTradeTax'][0];
	const monetarySummation = tradeSettlement['ram:SpecifiedTradeSettlementHeaderMonetarySummation'][0];

	// ram:ApplicableTradeTax
	if (tradeTax['ram:BasisAmount'][0] !== monetarySummation['ram:LineTotalAmount'][0]) {
		tradeTax['ram:BasisAmount'][0] = monetarySummation['ram:LineTotalAmount'][0];
	}

	// ram:SpecifiedTradeSettlementHeaderMonetarySummation
	if (tradeTax['ram:CalculatedAmount'][0] !== monetarySummation['ram:TaxTotalAmount'][0]._) {
		tradeTax['ram:CalculatedAmount'][0] = monetarySummation['ram:TaxTotalAmount'][0]._;
	}


	return new Builder().buildObject(xmlObj);
}


function saveXmlToFile(inputPdfPath, outputPath, updatedXmlContent) 
{
	const xmlOutputPath = path.join(
		outputPath,
		`${path.basename(inputPdfPath, path.extname(inputPdfPath))}${outputFileAppendix}.xml`
	);

	fs.writeFileSync(xmlOutputPath, updatedXmlContent, 'utf8');
	console.log(`Updated ZUGFeRD XML saved to: ${xmlOutputPath}`);

	return xmlOutputPath;
}



async function embedXmlToPdf(inputPdfPath, updatedXmlPath, outputPdfPath, xmlFileName) 
{
	const pdfBytes = fs.readFileSync(inputPdfPath);
	const pdfDocInput = await PDFDocument.load(pdfBytes);

	const pdfDocOutput = await pdfDocInput.copy(); // This is to clear the old invalid attachment

	const xmlBytes = fs.readFileSync(updatedXmlPath);
	pdfDocOutput.attach(xmlBytes, xmlFileName, { mimeType: 'application/xml' });

	const modifiedPdfBytes = await pdfDocOutput.save();
	fs.writeFileSync(outputPdfPath, modifiedPdfBytes);

	console.log(`Modified PDF saved to: ${outputPdfPath}`);
}

async function processZugferdPdf(inputPdfPath) 
{
	try 
	{
		// Extract en16931:2017 xrechnung_2.1 from input PDF with pdfjs-dist (it was the only that could read/parse the atachment. This was not possible with pdf-lib for me)
		//
		const xmlContent = await extractZugferdXmlFromPdf(inputPdfPath);

		// Parse XML
		//
		const xmlObj = await parseStringPromise(xmlContent.xml);


		// Correct XML errors
		//
		const updatedXmlContent = await modifyXmlContent(xmlObj);

		// Save corrected e-Rechnung to disk
		//
		const updatedXmlPath = saveXmlToFile(inputPdfPath, outputPath, updatedXmlContent);


		// Save corrected xml to PDF with pdf-lib
		//
		const outputPdfPath = path.join(
			outputPath,
			`${path.basename(inputPdfPath, path.extname(inputPdfPath))}${outputFileAppendix}.pdf`
		);

		await embedXmlToPdf(inputPdfPath, updatedXmlPath, outputPdfPath, xmlContent.filename);



		console.log('Process completed successfully.');

		return outputPdfPath;

	} 
	catch (err) 
	{
		console.error('Error:', err.message);
	}
}

// Example usage
const inputPdfPath = process.argv[2];

const outputPath = 'C:\\eRechungWerkstatt\\reparierteRechnungen';
const outputFileAppendix = "";

processZugferdPdf(inputPdfPath);


