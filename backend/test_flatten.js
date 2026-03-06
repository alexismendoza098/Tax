
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { parseXML, flattenXML } = require('./utils/xmlParser');

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const pkgId = '847BE5F7-B253-476B-AC02-577BA9D90150_01'; // From LS output

async function test() {
    const zipPath = path.join(DOWNLOADS_DIR, `${pkgId}.zip`);
    console.log(`Processing package: ${pkgId} at path: ${zipPath}`);

    if (!fs.existsSync(zipPath)) {
        console.error('File not found!');
        return;
    }

    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();
        console.log(`Found ${zipEntries.length} entries.`);

        for (const entry of zipEntries) {
            console.log(`Entry: ${entry.entryName}`);
            if (entry.entryName.toLowerCase().endsWith('.txt')) {
                const content = entry.getData().toString('utf8');
                console.log('TXT Content Preview:');
                console.log(content.substring(0, 200));
            }
            if (entry.entryName.toLowerCase().endsWith('.xml')) {
                const xmlContent = entry.getData().toString('utf8');
                console.log(`XML Content Length: ${xmlContent.length}`);
                
                try {
                    const parsed = await parseXML(xmlContent);
                    console.log('Parsed successfully.');
                    // console.log(JSON.stringify(parsed, null, 2));
                    
                    const flattened = flattenXML(parsed);
                    console.log(`Flattened rows: ${flattened.length}`);
                    if (flattened.length > 0) {
                        console.log('Sample row:', flattened[0]);
                    }
                } catch (e) {
                    console.error('Parse Error:', e.message);
                }
            }
        }
    } catch (e) {
        console.error('Zip Error:', e);
    }
}

test();
