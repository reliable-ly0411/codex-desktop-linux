"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFileSync,spawnSync} = require("node:child_process");
const script = path.join(__dirname,"sync-community-fork.sh");
for (const mode of ["changed","unchanged","conflict","skip"]) test(`real git sync preserves policies: ${mode}`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"community-sync-"));
 try {
  const upstream=path.join(root,"upstream"), fork=path.join(root,"fork.git"), work=path.join(root,"work"), bin=path.join(root,"bin");
  fs.mkdirSync(upstream); fs.mkdirSync(bin);
  const git=(args,cwd=upstream)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git(["init","-b","main"]);git(["config","user.name","test"]);git(["config","user.email","test@example.invalid"]);
  for(const d of [".github/workflows","scripts/ci","docs"])fs.mkdirSync(path.join(upstream,d),{recursive:true});
  for(const f of [".github/workflows/ci.yml","scripts/ci/policy.js","docs/community-release-policy.md","source.txt"])fs.writeFileSync(path.join(upstream,f),"baseline\n");
  git(["add","."]);git(["commit","-m","base"]);git(["clone","--bare",upstream,fork]);git(["clone",fork,work]);
  git(["config","user.name","test"],work);git(["config","user.email","test@example.invalid"],work);
  fs.writeFileSync(path.join(work,".github/workflows/ci.yml"),"fork guard\n");
  if(mode==="conflict")fs.writeFileSync(path.join(work,"source.txt"),"fork divergence\n");
  git(["add","."],work);git(["commit","-m","fork guard"],work);git(["push","origin","main"],work);
  if(mode!=="unchanged") {
   fs.writeFileSync(path.join(upstream,".github/workflows/ci.yml"),"upstream side effect\n");
   fs.writeFileSync(path.join(upstream,"scripts/ci/new-danger.js"),"upstream new policy\n");
   fs.writeFileSync(path.join(upstream,"source.txt"),"new upstream\n");git(["add","."]);git(["commit","-m","upstream"]);
  }
  git(["config",`url.${upstream}.insteadOf`,"https://github.com/ilysenko/codex-desktop-linux.git"],work);
  fs.writeFileSync(path.join(bin,"gh"),`#!/bin/bash\nif [[ "$*" == *git/ref* ]]; then git --git-dir='${fork}' rev-parse main; else echo ilysenko/codex-desktop-linux; fi\n`,{mode:0o755});
  const out=path.join(root,"output"); const result=spawnSync("bash",[script],{cwd:work,encoding:"utf8",env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GH_REPO:"reliable-ly0411/codex-desktop-linux",GITHUB_OUTPUT:out,GITHUB_STEP_SUMMARY:path.join(root,"summary"),SYNC_UPSTREAM:mode==="skip"?"false":"true"}});
  if(mode==="conflict") {assert.notEqual(result.status,0);assert.equal(fs.existsSync(out),false);}
  else {assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(path.join(work,".github/workflows/ci.yml"),"utf8"),"fork guard\n");assert.equal(fs.existsSync(path.join(work,"scripts/ci/new-danger.js")),false);assert.match(fs.readFileSync(out,"utf8"),/^source_sha=[a-f0-9]{40}\n$/);}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
