// Browser Automation script: browser-only demo data for installed plugin UIs.
// No server settings or records are changed; unknown demo RPCs fail closed.
const page = await browser.getPage("main");
await page.$eval("body", () => {
  if (window.__oddshipDemo) return;
  const realFetch = window.fetch.bind(window);
  const date = "2026-10-28T09:00:00Z";
  const repo = "gitlab.example.com/oddship/website";
  const post = (id, author, message, extra = {}) => ({id:id.repeat(26),thread_id:"b".repeat(26),author,message,created_at:date,channel:"release-planning",channel_id:"c".repeat(26),...extra});
  const posts = [post("b","@alex","## Website launch checklist\n\nThe review build is ready. Please check the keyboard navigation and the mobile layout before release.\n\n- [x] Build passes\n- [x] Documentation updated\n- [ ] Review the final changes",{reply_count:2}),post("d","@sam","Keyboard navigation looks good. I added a regression check for the search dialog.",{is_reply:true}),post("e","@morgan","Mobile layout reviewed. The release notes can link to the new walkthrough.",{is_reply:true})];
  const tasks = [
    {id:"demo-task-1",task_id:"WEB-42",project_key:"WEB",task_number:42,title:"Ship the website accessibility update",description:"<h2>Release checklist</h2><p>Review keyboard navigation and the mobile layout before publishing.</p><ul><li>Check visible focus states</li><li>Verify the search dialog</li><li>Update the release notes</li></ul>",state_name:"In progress",state_type:"started",priority:3,labels:[{id:"demo-label",name:"accessibility"}],assignees:[{user_id:"demo-user",username:"alex"}],comment_count:3,created_at:date,updated_at:date},
    {id:"demo-task-2",task_id:"WEB-43",project_key:"WEB",task_number:43,title:"Document the new search shortcuts",description:"Write a short guide for the command palette.",state_name:"Todo",state_type:"unstarted",priority:2,comment_count:1,created_at:date,updated_at:date},
    {id:"demo-task-3",task_id:"WEB-44",project_key:"WEB",task_number:44,title:"Polish the mobile navigation",description:"Verify the navigation at narrow widths.",state_name:"In review",state_type:"started",priority:1,comment_count:2,created_at:date,updated_at:date}
  ];
  const item = (number, title, kind="issue") => ({repo,kind,number,title,body:"## Review checklist\n\nImprove keyboard navigation and make focus visible across the application.\n\n- Add keyboard coverage for the search dialog\n- Keep focus inside the open dialog\n- Update the contributor guide",url:`https://${repo}/-/${kind==="mr"?"merge_requests":"issues"}/${number}`,state:"opened",author:"alex",assignees:["sam"],reviewers:["morgan"],labels:["accessibility","ready-for-review"],draft:false,sourceBranch:"fix/keyboard-navigation",targetBranch:"main",pipeline:"success",updatedAt:date});
  const issues=[item(42,"Keep focus inside the search dialog"),item(43,"Document keyboard shortcuts"),item(44,"Polish mobile navigation")];
  const prs=[item(18,"Improve keyboard navigation","mr"),item(19,"Add search shortcut documentation","mr")];
  const teaItem=i=>({number:i.number,title:i.title,body:i.body,url:`https://git.example.com/oddship/website/pulls/${i.number}`,state:"open",author:i.author,updatedAt:date,labels:i.labels,head:i.sourceBranch,base:"main",merged:false});
  const state = window.__oddshipDemo = {stars:[], step:"Browse the work that needs your attention", name:"Oddship plugins"};
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url,location.origin);
    const match=/^\/api\/v1\/plugins\/(oddship-gitlab|oddship-gitea|mattermost|bureaucat)\/rpc\/([^/]+)$/.exec(url.pathname);
    if (!match) return realFetch(input,init);
    const [,id,method]=match;
    let req={};try{req=typeof init?.body==="string"?JSON.parse(init.body):{}}catch{}
    let value;
    if(id==="oddship-gitea") {
      if(method==="connection") value={hostId:"host_demo",login:"demo",logins:[{name:"demo",url:"https://git.example.com",user:"alex"}]};
      if(method==="repos") value=[{name:"oddship/website",url:"https://git.example.com/oddship/website",description:"Website and contributor documentation"}];
      if(method==="items") value=(req.kind==="issues"?issues:prs).map(teaItem);
      if(method==="detail") value={item:teaItem(prs[0]),comments:[{id:1,author:"sam",body:"The keyboard checks pass. Ready for a final review.",createdAt:date}]};
    }
    if(id==="oddship-gitlab") {
      if(method==="repos") value={repos:[{repo,projectId:null}]};
      if(method==="status") value={host:"gitlab.example.com",username:"alex"};
      if(method==="list") {const all=req.kind==="mr"?prs:issues;const items=all.filter(i=>!req.query||i.title.toLowerCase().includes(req.query.toLowerCase()));value={items,total:items.length,hasMore:false,syncedAt:date,errors:[]}}
      if(method==="detail") value={item:req.kind==="mr"?prs[0]:issues[0],notes:[{id:1,author:"sam",body:"The regression test covers the reported focus issue. Thanks for including the reproduction steps.",createdAt:date,system:false}]};
      if(method==="users") value=[{id:1,username:"alex",name:"Alex"},{id:2,username:"sam",name:"Sam"}];
      if(method==="links") value=[];
      if(method==="sync") value={syncedAt:date,errors:[],count:5};
    }
    if(id==="mattermost") {
      if(method==="stars") value=state.stars;
      if(method==="star") {state.stars=[{conversationId:req.conversationId,title:req.title,createdAt:date,pinned:req.action==="pin"}];value=state.stars}
      if(method==="context") value={threadId:req.threadId,title:"Plan the website release",project:"Website",branch:"main",links:[],suggestedQuery:"website launch"};
      if(method==="read") {const kind=req.kind;let data=kind==="thread"?posts:kind==="channels"?[{id:"c".repeat(26),name:"release-planning",channel:"release-planning",type:"O",last_post_at:date}]:kind==="unread"?[{channel_id:"c".repeat(26),channel:"release-planning",unread:3}]:[posts[0],post("f","@sam","Documentation review is complete. The shortcut guide is ready.",{thread_id:"g".repeat(26),channel:"documentation",reply_count:0})];value={fetchedAt:date,cache:"fresh",refreshing:false,data}}
    }
    if(id==="bureaucat") {
      if(method==="connection") value={hostId:"host_demo",url:"https://tasks.example.com",username:"alex"};
      if(method==="execute") {const r=req.request||{};if(r.action==="projects") value={projects:[{id:"demo-project",project_key:"WEB",name:"Website",description:"Website improvements"}],page:1,total:1,total_pages:1};if(["mytasks","tasks"].includes(r.action)) {let list=tasks.filter(t=>(!r.q||t.title.toLowerCase().includes(r.q.toLowerCase()))&&(r.priority===undefined||t.priority===r.priority));value={tasks:list,page:1,total:list.length,total_pages:1}}if(r.action==="task")value=tasks[0]}
    }
    if(value===undefined) return new Response(JSON.stringify({ok:false,error:{message:"Demo capture: this operation does not contact the live service."}}),{status:400,headers:{"Content-Type":"application/json"}});
    return new Response(JSON.stringify({ok:true,result:value}),{headers:{"Content-Type":"application/json"}});
  };
  document.querySelectorAll("#oddship-capture-caption").forEach(e=>e.remove());
  const label=document.createElement("div");label.id="oddship-capture-caption";label.style.cssText="position:fixed;left:48px;right:0;bottom:0;z-index:2147483647;background:#131b2b;color:#fff;padding:15px 26px;font:14px system-ui;border-top:2px solid #6c8cff;pointer-events:none;display:flex;justify-content:space-between;gap:20px";label.innerHTML='<span id="oddship-capture-step">Browse the work that needs your attention</span><span style="color:#bac8e5;font-size:12px">DEMO DATA · NO LIVE RECORDS</span>';document.body.append(label);
});
undefined;
