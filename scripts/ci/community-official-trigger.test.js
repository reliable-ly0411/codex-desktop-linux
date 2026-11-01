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
const {checkPackageUpdate,compareVersions,historyMarker,verifyPublishedHistory}=require("./community-official-trigger.js");
test("Debian version ordering includes epochs, tilde prereleases and revisions",()=>{
 assert.equal(compareVersions("1:1.0","9.9"),1);
 assert.equal(compareVersions("2.0~rc1","2.0"),-1);
 assert.equal(compareVersions("2.0-2","2.0-10"),-1);
 assert.equal(compareVersions("2.0","2.0-0"),0);
});
test("baseline and later history reject downgrade and same-version payload drift before skip",()=>{
 const baseline={...metadata,version:"2.0.0"}, policy={baselinePackages:[baseline]};
 assert.equal(checkPackageUpdate(baseline,policy,[]),false);
 assert.throws(()=>checkPackageUpdate({...baseline,version:"1.0.0"},policy,[]),/downgrade/);
 assert.throws(()=>checkPackageUpdate({...baseline,sha256:"f".repeat(64)},policy,[]),/SHA drift/);
 const newer={...metadata,version:"3.0.0"};const release={tag_name:`official-${officialIdentity(newer)}`,body:historyMarker(newer)};
 assert.throws(()=>checkPackageUpdate(baseline,policy,[release]),/downgrade/);
 assert.equal(checkPackageUpdate({...metadata,version:"4.0.0"},policy,[release]),true);
 assert.throws(()=>checkPackageUpdate(newer,{baselinePackages:[]},[]),/baseline missing/);
 assert.throws(()=>checkPackageUpdate(newer,policy,[{tag_name:"official-broken"}]),/history/);
});
test("published provenance must match asset digest and exact signed-index metadata",()=>{
 const crypto=require("node:crypto"), key="e".repeat(64);
 const info={metadata,source:"a".repeat(40),key,upstreamKey:officialIdentity(metadata)};
 const bytes=JSON.stringify(info), digest="sha256:"+crypto.createHash("sha256").update(bytes).digest("hex");
 const release={tag_name:`official-${info.upstreamKey}`,body:historyMarker(metadata)+`\n<!-- community-build-key:${key} -->`,assets:[{id:1,name:"build-info.json",digest}]};
 verifyPublishedHistory([release],()=>bytes);
 assert.throws(()=>verifyPublishedHistory([release],()=>bytes+" "),/digest/);
 assert.throws(()=>verifyPublishedHistory([{...release,assets:[]}],()=>bytes),/missing/);
});
