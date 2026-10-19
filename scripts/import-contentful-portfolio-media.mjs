#!/usr/bin/env node
/**
 * One-time Contentful media migration. Run inside the deployed Atlas *server*
 * container using: node /tmp/import-contentful-portfolio-media.mjs
 * No credentials here. Requests go only to the loopback Atlas HTTP service.
 * Never publishes the drafts. Rerunnable: Atlas deduplicates identical assets.
 */
import { createHash } from "node:crypto";

const manifest = {
  "assets": [
    {
      "id": "1jKZANnz7Q4iS5VFVnY7PL",
      "title": "amazon",
      "fileName": "amazon.jpg",
      "mimeType": "image/jpeg",
      "expectedBytes": 56997,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/1jKZANnz7Q4iS5VFVnY7PL/19eee0eb7fcb3e6842ed41e6fd71e3c9/amazon.jpg"
    },
    {
      "id": "3u6fcmRfi4FWeBROJ0WI94",
      "title": "electronic arts",
      "fileName": "electronic_arts.jpg",
      "mimeType": "image/jpeg",
      "expectedBytes": 72815,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/3u6fcmRfi4FWeBROJ0WI94/410650fb055f5cd194177a58c408ca9c/electronic_arts.jpg"
    },
    {
      "id": "3BqrCkox1cnpxcsQB3rCvy",
      "title": "EA Icon Logo",
      "fileName": "ea-com-logo-Photoroom.png",
      "mimeType": "image/png",
      "expectedBytes": 59813,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/3BqrCkox1cnpxcsQB3rCvy/ffa7c652cc97bbb004b333dd5fb073fb/ea-com-logo-Photoroom.png"
    },
    {
      "id": "1nDKdiEIuJ9p0dcl0C2fzW",
      "title": "Amazon Icon Logo",
      "fileName": "Amazon Icon Logo.webp",
      "mimeType": "image/webp",
      "expectedBytes": 10622,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/1nDKdiEIuJ9p0dcl0C2fzW/0955bddb61997feb6acd5308f6325325/Amazon_Icon_Logo.webp"
    },
    {
      "id": "7eaI1YSd2GEx7tO0n9WHyY",
      "title": "Racenet Time Trials Leaderboard",
      "fileName": "image.png",
      "mimeType": "image/png",
      "expectedBytes": 2651631,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/7eaI1YSd2GEx7tO0n9WHyY/3a8fb81bd389e124316215b0fcd32a30/image.png"
    },
    {
      "id": "7fRdsUjDSLAgXxAMZGMefe",
      "title": "Racenet Time Trials Detailed Analysis",
      "fileName": "image.png",
      "mimeType": "image/png",
      "expectedBytes": 979697,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/7fRdsUjDSLAgXxAMZGMefe/dc47704bf7c0d31261aa9e4d7ed57218/image.png"
    },
    {
      "id": "6DZ1IjPPUQGgTTc2Egps6b",
      "title": "Racenet Leagues",
      "fileName": "image.png",
      "mimeType": "image/png",
      "expectedBytes": 5327163,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/6DZ1IjPPUQGgTTc2Egps6b/46bae9824c182766b16576e42a1f7abc/image.png"
    },
    {
      "id": "146IcnosysxNm02gnp2xnk",
      "title": "EA Racenet Logo",
      "fileName": "EA Racenet.png",
      "mimeType": "image/png",
      "expectedBytes": 15257,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/146IcnosysxNm02gnp2xnk/46703475471bd2d2613cba20f8e3bc69/EA_Racenet.png"
    },
    {
      "id": "5KSMGbdtCwtexx2b7WofAT",
      "title": "EA Racenet Circle",
      "fileName": "EA Racenet-fotor-20260927121624.png",
      "mimeType": "image/png",
      "expectedBytes": 28649,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/5KSMGbdtCwtexx2b7WofAT/aeacfe6b13ed3023586ca784be672177/EA_Racenet-fotor-20260927121624.png"
    },
    {
      "id": "4ddJuvvUH8gMO8Qy84eQWm",
      "title": "What If? Circle Logo",
      "fileName": "What_If__upscaled-fotor-2026092712299_upscaled.png",
      "mimeType": "image/png",
      "expectedBytes": 2526321,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/4ddJuvvUH8gMO8Qy84eQWm/12f873319780122d5f03e6d3dbf9f348/What_If__upscaled-fotor-2026092712299_upscaled.png"
    },
    {
      "id": "5OJkXnkmZy8Px9oGDKSZEU",
      "title": "What If? Image 1",
      "fileName": "What If? Image 1.png",
      "mimeType": "image/png",
      "expectedBytes": 586723,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/5OJkXnkmZy8Px9oGDKSZEU/9ac7091ea5f39f17360277f66b6352e5/What_If"
    },
    {
      "id": "1pcTizW79bdtc1FFZBFreX",
      "title": "What If? Image 2",
      "fileName": "What If? Image 2.jpg",
      "mimeType": "image/jpeg",
      "expectedBytes": 101514,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/1pcTizW79bdtc1FFZBFreX/3ae113d2e54a1c8385115ca06df5f7ae/What_If"
    },
    {
      "id": "4iQkcpRZdJtdoCdADTyvfE",
      "title": "What If? Image 3",
      "fileName": "What If? Image 3.jpg",
      "mimeType": "image/jpeg",
      "expectedBytes": 81322,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/4iQkcpRZdJtdoCdADTyvfE/e4f95d98bd7c1bf1b6ef8f20d0c54899/What_If"
    },
    {
      "id": "6yrSvZSmEtqDOtSb78mzzr",
      "title": "Football Match Engine 2",
      "fileName": "Football Match Engine 2.png",
      "mimeType": "image/png",
      "expectedBytes": 209087,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/6yrSvZSmEtqDOtSb78mzzr/e17a086d9b0b17e1ea05a29d82dab873/Football_Match_Engine_2.png"
    },
    {
      "id": "5jJ1Uswy5IIByadldFCO8j",
      "title": "Football Match Engine",
      "fileName": "Football Match Engine.png",
      "mimeType": "image/png",
      "expectedBytes": 119959,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/5jJ1Uswy5IIByadldFCO8j/37e1ceefc605fb005c69afba4f0f006a/Football_Match_Engine.png"
    },
    {
      "id": "7H28HzNrdlNyWwAFAtnjni",
      "title": "Football Match Engine 3",
      "fileName": "Football Match Engine 3.png",
      "mimeType": "image/png",
      "expectedBytes": 130357,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/7H28HzNrdlNyWwAFAtnjni/6d3092382ca560a3b1d112bcd467faaf/Football_Match_Engine_3.png"
    },
    {
      "id": "5amnFKRxgXt4ce544rfLUG",
      "title": "Football Match Engine 4",
      "fileName": "Football Match Engine 4.png",
      "mimeType": "image/png",
      "expectedBytes": 173664,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/5amnFKRxgXt4ce544rfLUG/6f475fcb2f865ce65db115aeac9675ab/Football_Match_Engine_4.png"
    },
    {
      "id": "dUobI7DM4GEK1VOwJ12sz",
      "title": "Football Match Engine Logo",
      "fileName": "Football Match Simulation Engine Logo.png",
      "mimeType": "image/png",
      "expectedBytes": 261906,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/dUobI7DM4GEK1VOwJ12sz/0fac640a1250aa055ad8244762f0da90/Football_Match_Simulation_Engine_Logo.png"
    },
    {
      "id": "7ssh1hXNmuzzhInuJN92oE",
      "title": "CV Affan Khan",
      "fileName": "CV_Affan_Khan.pdf",
      "mimeType": "application/pdf",
      "expectedBytes": 101703,
      "url": "https://assets.ctfassets.net/jf4sbknqx2y6/7ssh1hXNmuzzhInuJN92oE/b9f8d38a2807bd39b3163988ba8831a8/CV_Affan_Khan.pdf"
    },
    {
      "id": "3F0BpeFzYVb2D61kp6GFk8",
      "title": "image",
      "fileName": "image.png",
      "mimeType": "image/png",
      "expectedBytes": 1426628,
      "url": "https://images.ctfassets.net/jf4sbknqx2y6/3F0BpeFzYVb2D61kp6GFk8/9d78031f51506c9e7d985079eec26c16/image.png"
    }
  ],
  "maps": [
    {
      "type": "profile",
      "recordId": "690e05f7-7926-4156-b702-2b0fb57821dc",
      "name": "Affan",
      "refs": {
        "cvAssetId": "7ssh1hXNmuzzhInuJN92oE"
      }
    },
    {
      "type": "experience",
      "recordId": "64acb472-4369-4656-8c6c-80faf5b3b693",
      "name": "Amazon",
      "refs": {
        "imageAssetId": "1nDKdiEIuJ9p0dcl0C2fzW"
      }
    },
    {
      "type": "experience",
      "recordId": "cbc2ccb6-afbb-4a4a-afa8-6a23207b1994",
      "name": "Electronic Arts",
      "refs": {
        "imageAssetId": "3BqrCkox1cnpxcsQB3rCvy"
      }
    },
    {
      "type": "projects",
      "recordId": "2178bfb0-caac-4880-9ed0-3f95f3ce8eb4",
      "name": "EA Racenet",
      "refs": {
        "imageAssetId": "7fRdsUjDSLAgXxAMZGMefe",
        "galleryAssetIds": [
          "7fRdsUjDSLAgXxAMZGMefe",
          "7eaI1YSd2GEx7tO0n9WHyY",
          "6DZ1IjPPUQGgTTc2Egps6b"
        ]
      }
    },
    {
      "type": "projects",
      "recordId": "cc37e697-98ab-4e53-b40c-9d8dcf916fba",
      "name": "What If?",
      "refs": {
        "imageAssetId": "5OJkXnkmZy8Px9oGDKSZEU",
        "galleryAssetIds": [
          "5OJkXnkmZy8Px9oGDKSZEU",
          "1pcTizW79bdtc1FFZBFreX",
          "4iQkcpRZdJtdoCdADTyvfE"
        ]
      }
    },
    {
      "type": "projects",
      "recordId": "ed5f66bb-c560-401a-a41d-3615d556b528",
      "name": "Football Match Engine",
      "refs": {
        "imageAssetId": "5jJ1Uswy5IIByadldFCO8j",
        "galleryAssetIds": [
          "5jJ1Uswy5IIByadldFCO8j",
          "6yrSvZSmEtqDOtSb78mzzr",
          "7H28HzNrdlNyWwAFAtnjni",
          "5amnFKRxgXt4ce544rfLUG"
        ]
      }
    },
    {
      "type": "projects",
      "recordId": "796283a3-e263-47c4-94c3-72e7f70a801e",
      "name": "Ascii Shape",
      "refs": {
        "imageAssetId": "3F0BpeFzYVb2D61kp6GFk8",
        "galleryAssetIds": [
          "3F0BpeFzYVb2D61kp6GFk8"
        ]
      }
    }
  ]
};

const api = "http://127.0.0.1:3000/api/tools/";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tool(name, input = {}) {
    const response = await fetch(api + name, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, client: "contentful-r2-migration" }),
        signal: AbortSignal.timeout(180000),
    });
    const body = await response.text();
    let result;
    try { result = JSON.parse(body); } catch { throw new Error(name + ": non-JSON response HTTP " + response.status); }
    if (!response.ok || result.error) throw new Error(name + ": " + JSON.stringify(result).slice(0,600));
    return result;
}

async function download(asset) {
    const url = new URL(asset.url);
    if (url.protocol !== "https:" || !["images.ctfassets.net", "assets.ctfassets.net"].includes(url.hostname))
        throw new Error("Unexpected Contentful source URL for " + asset.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(90000), redirect: "error" });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const declared = Number(response.headers.get("content-length"));
            if (declared && declared > 25 * 1024 * 1024) throw new Error("Source asset exceeds Atlas 25 MB limit");
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length !== asset.expectedBytes)
                throw new Error("File size mismatch: expected " + asset.expectedBytes + " got " + bytes.length);
            return bytes;
        } catch (error) {
            if (attempt === 3) throw new Error("Could not download " + asset.title + ": " + error.message);
            await sleep(attempt * 1000);
        }
    }
}

const assetIds = new Map();
const results = [];
for (const [index, asset] of manifest.assets.entries()) {
    console.log(`[${index+1}/${manifest.assets.length}] ${asset.title} (${asset.expectedBytes} bytes)`);
    try {
        const bytes = await download(asset);
        // Atlas validates the content type and generates local/R2 image variants.
        const uploaded = await tool("upload_portfolio_media", {
            fileName: asset.fileName, mimeType: asset.mimeType,
            base64: bytes.toString("base64"), altText: asset.title,
            caption: "Migrated from Contentful asset " + asset.id,
        });
        if (!uploaded.id || uploaded.status !== "active") throw new Error("Unexpected Atlas upload response");
        assetIds.set(asset.id, uploaded.id);
        results.push({ title: asset.title, mediaId: uploaded.id, sha256: createHash("sha256").update(bytes).digest("hex") });
        console.log("  imported: " + uploaded.id);
    } catch (error) {
        console.error("  FAILED: " + error.message);
    }
}
const failed = manifest.assets.filter(a => !assetIds.has(a.id));
if (failed.length) {
    console.error("Assets missing ("+failed.length+"): "+failed.map(a=>a.title).join(", "));
    process.exitCode = 1;
} else {
    const drafts = await tool("list_portfolio_entries");
    for (const entry of manifest.maps) {
        const current = drafts.find(x => x.id === entry.recordId && x.contentType === entry.type);
        if (!current || current.status === "published") throw new Error("Draft missing or already published: "+entry.name);
        const data = { ...current.data };
        for (const [key, value] of Object.entries(entry.refs)) {
            data[key] = Array.isArray(value) ? value.map(id => {
                if (!assetIds.has(id)) throw new Error("Missing media for "+key+" "+id);
                return assetIds.get(id);
            }) : assetIds.get(value);
        }
        await tool("save_portfolio_draft", {contentType:entry.type,recordId:entry.recordId,data});
        console.log("Linked "+entry.name);
    }
    console.log("SUCCESS: "+results.length+" original Contentful assets imported, "+manifest.maps.length+" drafts linked. Nothing published.");
}
