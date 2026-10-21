export function loadExamples(store) {
  const entries=[
    ['project','Amara · Example Studio','Can you approve the revised proposal?','We have updated the scope. Could you approve it before we send the proposal tomorrow?','needs-you','today',['possible_action']],
    ['newsletter','Field Notes','This week: better ways to work','A fictional weekly reading list, with no action required.','digest','can-wait',[]],
    ['notification','Example Workspace','Your export is ready','Your requested export has completed. This is a routine confirmation.','archive','can-wait',[]],
    ['promotion','Example Offers','A discount you probably do not need','A fictional generic promotional email.','holding','can-wait',[]],
    ['financial','Example Supplies','Invoice attached for review','Please check the attached invoice. The attachment has not been read.','review','unclear',['incomplete_context','retention_guard']]
  ];
  entries.forEach(([category,sender,subject,body,destination,urgency,reasons],i)=>{
    const id=`demo:${i+1}`;
    store.add({id,threadId:id,sender,to:'you@example.test',subject,body,snippet:body,receivedAt:new Date(Date.now()-i*1800000).toISOString(),labels:['INBOX'],hasAttachment:i===4,incomplete:i===4},'demo');
    store.classified(id,{category,destination,urgency,reasons,origin:'example',probability:0.99},store.get('policy').version);
  });
}
