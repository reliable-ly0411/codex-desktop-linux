"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {officialIdentity,requireLicense,REPOSITORY}=require("./community-official-trigger.js");
const metadata={repository:REPOSITORY,package:"chatgpt",version:"1.2.3",architecture:"amd64",sha256:"a".repeat(64),inReleaseSha256:"b".repeat(64),packagesSha256:"c".repeat(64),signatureFingerprint:"D".repeat(40)};
test("official stable identity excludes wrapper commits and index-only resigning",()=>{
 const key=officialIdentity(metadata);
 assert.equal(officialIdentity({...metadata,source:"a".repeat(40)}),key);
 assert.equal(officialIdentity({...metadata,inReleaseSha256:"f".repeat(64),packagesSha256:"e".repeat(64)}),key);
 for(const delta of [{version:"1.2.4"},{architecture:"arm64"},{sha256:"f".repeat(64)}])assert.notEqual(officialIdentity({...metadata,...delta}),key);
 for(const field of Object.keys(metadata))assert.throws(()=>officialIdentity({...metadata,[field]:null}));
});
test("license is tied to exact official version, architecture and bytes",()=>{
 assert.throws(()=>requireLicense({redistributionApprovals:[]},metadata),/permission evidence/);
 const e={version:metadata.version,architecture:metadata.architecture,packageSha256:metadata.sha256,permission:"redistribute-repackaged-payload",reviewedBy:"test",evidenceUrl:"https://example.invalid/test"};
 assert.equal(requireLicense({redistributionApprovals:[e]},metadata),e);
 for(const field of Object.keys(e))assert.throws(()=>requireLicense({redistributionApprovals:[{...e,[field]:null}]},metadata));
});
