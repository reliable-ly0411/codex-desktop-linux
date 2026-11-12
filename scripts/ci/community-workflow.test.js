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
test("license pause is visible and all package work still requires a permitted build plan",()=>{
 const build=workflow.slice(workflow.indexOf("  build:\n"));
 assert.match(build,/name: 同步成功、发布因许可证据不足而暂停\n        if: steps.plan.outputs.release_status == 'paused_license'/);
 assert.doesNotMatch(build,/continue-on-error/);
 for(const step of build.split(/\n      - /).slice(1)) {
  if(/rust-toolchain|sudo apt-get|cargo test|community-build-deb\.sh|upload-artifact|ARTIFACT_URL|community-build\.js publish/.test(step)) {
   assert.match(step,/if: steps.plan.outputs.build == 'true'/);
  }
 }
});
