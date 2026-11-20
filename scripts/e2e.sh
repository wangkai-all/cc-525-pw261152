#!/usr/bin/env bash
set -euo pipefail
B=http://localhost:3108/api
login() {
  curl -s -X POST "$B/sessions" -H 'content-type: application/json' \
    -d "{\"userId\":\"$1\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionId))"
}
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const f=new Function('x','return x.'+process.argv[1]);console.log(f(JSON.parse(d)))})" "$1"; }

ADMIN=$(login u-00001); ANALYST=$(login u-00002); REVIEWER=$(login u-00003); VIEWER=$(login u-00004)

echo "== 1. viewer vs admin see identical summary/cells/timeline =="
curl -s "$B/reports/R-00001" -H "x-session-id: $VIEWER" > /tmp/e2e-viewer.json
curl -s "$B/reports/R-00001" -H "x-session-id: $ADMIN" > /tmp/e2e-admin.json
node -e "
const a=require('/tmp/e2e-admin.json'), v=require('/tmp/e2e-viewer.json');
const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
console.log('summary equal:', eq(a.summary,v.summary));
console.log('cells equal:', eq(a.latestCells,v.latestCells));
console.log('timeline length equal:', a.timeline.length===v.timeline.length);
console.log('versions equal:', eq(a.versions.map(x=>x.id),v.versions.map(x=>x.id)));
"

echo "== 2. analyst previews caliber change =="
curl -s -X POST "$B/changes/preview" -H "x-session-id: $ANALYST" -H 'content-type: application/json' \
 -d '{"kind":"METRIC_CALIBER","metricId":"M-00001","newCaliber":"按签收确认收入（不含税）","newMultiplier":1.15,"reason":"E2E口径调整"}' > /tmp/e2e-preview.json
node -e "const r=require('/tmp/e2e-preview.json');console.log('impacted:',r.impactedReportIds.join(','),'diffs on first:',r.impacted[0].diffPreview.length)"

echo "== 3. create + submit + approve + publish =="
curl -s -X POST "$B/revisions" -H "x-session-id: $ANALYST" -H 'content-type: application/json' \
 -d '{"kind":"METRIC_CALIBER","metricId":"M-00001","newCaliber":"按签收确认收入（不含税）","newMultiplier":1.15,"reason":"E2E口径调整"}' > /tmp/e2e-revs.json
REV=$(jget 'find(r=>r.reportId==="R-00001").id' < /tmp/e2e-revs.json)
GRP=$(jget 'find(r=>r.reportId==="R-00001").changeGroupId' < /tmp/e2e-revs.json)
echo "revision: $REV group: $GRP"
curl -s -X POST "$B/revisions/$REV/submit" -H "x-session-id: $ANALYST" > /dev/null
TASK=$(curl -s "$B/review-tasks?status=PENDING" -H "x-session-id: $REVIEWER" | jget "find(t=>t.revisionId==='$REV').id")
curl -s -X POST "$B/review-tasks/$TASK/decision" -H "x-session-id: $REVIEWER" -H 'content-type: application/json' -d '{"decision":"APPROVED","comment":"E2E通过"}' > /dev/null
curl -s -X POST "$B/revisions/$REV/publish" -H "x-session-id: $ADMIN" > /tmp/e2e-pub.json
node -e "const v=require('/tmp/e2e-pub.json');console.log('published:',v.id,'V'+v.versionNo,v.source,'reason:',v.reason)"

echo "== 4. re-publish blocked (immutable version) =="
curl -s -X POST "$B/revisions/$REV/publish" -H "x-session-id: $ADMIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const e=JSON.parse(d).error;console.log(e.code,'-',e.message)})"

echo "== 5. reminder duplicate suppression =="
curl -s -X POST "$B/revisions" -H "x-session-id: $ANALYST" -H 'content-type: application/json' \
 -d '{"kind":"SOURCE_DATA","dataId":"SD-00003","periodValues":{"2026-Q1":640},"reason":"E2E成本修正"}' > /tmp/e2e-revs2.json
R2=$(jget 'find(r=>r.reportId==="R-00003").id' < /tmp/e2e-revs2.json)
curl -s -X POST "$B/revisions/$R2/submit" -H "x-session-id: $ANALYST" > /dev/null
curl -s -X POST "$B/revisions/$R2/remind" -H "x-session-id: $ANALYST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('remind #1:',JSON.stringify(JSON.parse(d))))"
curl -s -X POST "$B/revisions/$R2/remind" -H "x-session-id: $ANALYST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('remind #2:',JSON.stringify(JSON.parse(d))))"

echo "== 6. rollback R-00001 to V1 (new immutable version) =="
# open revisions correctly block rollback; cancel every open one from step 5 first
node -e "const rs=require('/tmp/e2e-revs2.json');console.log(rs.map(r=>r.id).join(' '))" | tr ' ' '\n' | while read -r rid; do
  [ -n "$rid" ] && curl -s -X POST "$B/revisions/$rid/cancel" -H "x-session-id: $ADMIN" -H 'content-type: application/json' -d '{"comment":"E2E清理，准备回滚"}' > /dev/null
done
V1=$(curl -s "$B/reports/R-00001" -H "x-session-id: $ADMIN" | jget 'versions.find(v=>v.versionNo===1).id')
curl -s -X POST "$B/reports/R-00001/rollback" -H "x-session-id: $ADMIN" -H 'content-type: application/json' \
 -d "{\"targetVersionId\":\"$V1\",\"reason\":\"E2E回滚验证\"}" > /tmp/e2e-rb.json
node -e "const v=require('/tmp/e2e-rb.json');console.log('rollback:',v.id,'V'+v.versionNo,'restored',v.rolledBackFrom)"

echo "== 7. timeline =="
curl -s "$B/reports/R-00001" -H "x-session-id: $VIEWER" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{JSON.parse(d).timeline.forEach(t=>console.log(t.kind.padEnd(9),t.label,'|',t.reason))})"

echo "== 8. notification dedup stats =="
curl -s "$B/notifications" -H "x-session-id: $ADMIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d);console.log('rows:',n.length,'suppressed duplicates:',n.reduce((a,x)=>a+x.dupCount,0))})"

echo "== 9. audit log =="
curl -s "$B/audit" -H "x-session-id: $ADMIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log('events:',a.length);console.log('actions:',[...new Set(a.map(x=>x.action))].join(', '))})"

echo "== 10. permission denials =="
curl -s -o /dev/null -w "viewer create revision: %{http_code}\n" -X POST "$B/revisions" -H "x-session-id: $VIEWER" -H 'content-type: application/json' -d '{"kind":"SOURCE_DATA","dataId":"SD-00003","periodValues":{"2026-Q1":1},"reason":"x"}'
curl -s -o /dev/null -w "analyst publish: %{http_code}\n" -X POST "$B/revisions/$REV/publish" -H "x-session-id: $ANALYST"
curl -s -o /dev/null -w "viewer audit: %{http_code}\n" "$B/audit" -H "x-session-id: $VIEWER"
