"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const workflow=fs.readFileSync(path.join(__dirname,"../../.github/workflows/sync-upstream.yml"),"utf8");
test("manual dispatch defaults to an explicit non-package sync-only mode",()=>{
 assert.match(workflow,/run_mode:[\s\S]*?options: \[sync-only, release-candidate\]\n        default: sync-only/);
 const build=workflow.slice(workflow.indexOf("  build:\n"));
 assert.match(build,/needs: \[sync, verify\]/);
 assert.match(build,/if: github.event_name != 'workflow_dispatch' \|\| inputs.run_mode == 'release-candidate'/);
});
test("sync-only verification is read-only and has no package publication steps",()=>{
 const verify=workflow.slice(workflow.indexOf("  verify:\n"),workflow.indexOf("  build:\n"));
 assert.match(verify,/permissions:\n      contents: read/);
 assert.match(verify,/node --test scripts\/ci\/community-\*\.test\.js/);
 assert.doesNotMatch(verify,/community-build\.js (plan|publish|download)|upload-artifact|contents: write/);
});
