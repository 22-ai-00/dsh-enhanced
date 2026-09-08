/** Deterministic installation fixture; never evidence of model intelligence. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { strategyDevelopmentCorpus } from '@dsh-enhanced/assistant-evaluation/benchmark/strategy'
import { appendFileSync } from 'node:fs'
const solutions = {
  'integer-sum': "awk '{for(i=1;i<=NF;i++)s+=$i}END{print s+0}'",
  'merge-touching-intervals': "sort -n -k1,1 -k2,2 | awk 'NR==1{s=$1;e=$2;next} $1<=e+1{if($2>e)e=$2;next} {print s,e;s=$1;e=$2} END{if(NR)print s,e}'",
  'word-frequency-lexical-ties': "export LC_ALL=C; awk '{for(i=1;i<=NF;i++)c[$i]++} END{for(w in c)print w,c[w]}' | sort -k2,2nr -k1,1",
  'dependency-topological-order': "awk 'NF==2{nodes[$1]=1;nodes[$2]=1;if(!edges[$1 SUBSEP $2]++){degree[$2]++}} END{for(n in nodes)total++;for(i=0;i<total;i++){best=\"\";for(n in nodes)if(!done[n]&&!degree[n]&&(best==\"\"||n<best))best=n;if(best==\"\"){print \"CYCLE\";exit} done[best]=1;answer=answer best ORS;for(n in nodes)if(edges[best SUBSEP n])degree[n]--}printf \"%s\",answer}'",
}
const record = value => { if (process.env.DSH_STRATEGY_FIXTURE_TRACE) appendFileSync(process.env.DSH_STRATEGY_FIXTURE_TRACE, JSON.stringify(value) + '\n', { mode: 0o600 }) }
export function createNativeAdapter(_model, { ctx, workspace }) {
  record({ kind: 'factory', workspace })
  let calls=0, compared=false, task
  const written=new Set()
  class Adapter extends LlmAdapter {
    providerInfo(id) { return { id, name:id } }
    async resolveModel(provider,id) { return {provider,id,name:id,inputModalities:['text']} }
    async *stream(options) {
      calls++
      const agent=ctx.agents.currentInitiator()
      const child=agent.session.header.origin==='subagent'
      record({kind:'request',workspace,child,options})
      if(!task) task=strategyDevelopmentCorpus.find(item=>JSON.stringify(options.messages).includes(JSON.stringify(item.objective).slice(1, -1)))
      if(!task) throw new Error('fixture could not identify public objective')
      const goal=ctx.get('goals').get(agent)
      let name, args={}
      if(child) { if((options.tools??[]).length) throw new Error('child has tools') }
      else if(!goal) { name='goal_create';args={objective:task.objective,max_goal_rounds:3} }
      else if(goal.roundsStarted>0&&!compared&&options.tools?.some(t=>t.name==='goal_strategy')) {
        compared=true;name='goal_strategy';args={kind:'compare',question:'Compare two implementations of the public task.'}
      } else if(goal.roundsStarted>0&&!written.has(goal.roundsStarted)) {
        written.add(goal.roundsStarted);name='isolation_run';args={grant_id:'benchmark-work',idempotency_key:`artifact-${goal.roundsStarted}`,command:'cp source answer.sh',files:[{path:'source',content:goal.roundsStarted===1?'printf wrong':solutions[task.id]}],artifacts:['answer.sh'],timeout_ms:15000}
      }
      if(name) {
        const id=ToolCallId(`call-${calls}`), json=JSON.stringify(args)
        yield {type:'block-start',index:0,blockType:'tool-call'}
        yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:json}
        yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:json}}
      } else {
        const text='Continue from independent feedback.'
        yield {type:'block-start',index:0,blockType:'text'}
        yield {type:'text-delta',index:0,text}
        yield {type:'block-end',index:0,block:{type:'text',text}}
      }
      yield {type:'usage',usage:{inputTokens:10,outputTokens:2}}
      yield {type:'finish',reason:{kind:name?'tool-calls':'stop'}}
    }
  }
  return {adapter:new Adapter(),inputTokenUpperBound:()=>10,dispose(){record({kind:'disposed',workspace})}}
}
