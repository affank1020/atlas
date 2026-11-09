import assert from 'node:assert/strict';
import test from 'node:test';
import {validatePresentation,renderTemplate} from '../apps/server/src/views.js';
import {viewDocument} from '../apps/server/src/view-runtime.js';

const manifest={viewKitVersion:1 as const,capabilities:['client-script' as const]};

test('rich text preserves LaTeX and loads pinned math renderer only when needed',()=>{
 const template='<atlas-rich-text>{{detail}}</atlas-rich-text>';
 validatePresentation(template,'',manifest);
 const detail='The transition probability $p_{i,j}$ is defined.\n\n$$\\sum_{k\\in S} p_{i,k}(m)p_{k,j}(n)$$';
 const html=renderTemplate(template,{detail},manifest);
 assert.match(html,/p_\{i,j\}/);
 const output=viewDocument({html,css:'',manifest,data:{},params:{}});
 assert.match(output,/katex@0\.19\.1\/dist\/katex\.min\.js/);
 assert.match(output,/integrity="sha384-a1WQdjRj162i159OYq041X6I4K8NenkrI09LlPmiHg0YOb7CR\+wJOraXwK9abpnE"/);
 assert.match(output,/output:'mathml'/);
 assert.match(output,/trust:false/);
 assert.match(output,/connect-src 'none'/);
 assert.match(output,/font-src 'none'/);
});

test('ordinary Views do not fetch math rendering code',()=>{
 const output=viewDocument({html:'<p>Ordinary content</p>',css:'',manifest,data:{},params:{}});
 assert.doesNotMatch(output,/cdn\.jsdelivr\.net/);
 assert.throws(()=>validatePresentation('<atlas-rich-text>x</atlas-rich-text>',''),/viewKitVersion/i);
});

test('escaped database content remains plain text, not executable markup',()=>{
 const html=renderTemplate('<atlas-rich-text>{{detail}}</atlas-rich-text>',{detail:'<script>alert(1)</script> $\\pi$'},manifest);
 assert.doesNotMatch(html,/<script>/);
 assert.match(html,/&lt;script&gt;/);
 validatePresentation(html,'',manifest);
});
