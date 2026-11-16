import {useEffect,useState} from 'react'
import {Eye,RefreshCw} from 'lucide-react'
import {api} from '../api'
import type {ServiceCard} from '../clientService'

type Review={id:string;card_revision:number;image_hash:string;state:string;message:string;result:{verdict:string;summary:string;issues:{area:string;severity:string;message:string;suggestion:string}[]}|null}
export default function ClientCardReview({card,dirty,imageHash}:{card?:ServiceCard;dirty:boolean;imageHash?:string}){
 const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0)
 useEffect(()=>{setReview(null);if(!card)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;async function load(){try{const value=await api<{review:Review|null}>(`/client-service/cards/${card!.id}/review`,{signal:controller.signal});if(!controller.signal.aborted){setReview(value.review);if(value.review&&['preparing','queued','running'].includes(value.review.state))timer=setTimeout(load,4000)}}catch{/* Review status does not prevent editing or downloading. */}}void load();return()=>{controller.abort();clearTimeout(timer)}},[card?.id,card?.revision,imageHash,reload])
 const pending=review&&['preparing','queued','running'].includes(review.state)
 const current=review&&review.card_revision===card?.revision&&review.image_hash===imageHash&&!dirty
 async function start(){if(!card)return;setBusy(true);setError('');try{const value=await api<Review>(`/client-service/cards/${card.id}/review`,{method:'POST',body:JSON.stringify({request_id:crypto.randomUUID(),expected_revision:card.revision})});setReview(value);setReload(value=>value+1)}catch(reason){setError((reason as Error).message)}finally{setBusy(false)}}
 return <details className="client-review-panel"><summary><Eye size={14}/>成品视觉复核<span>{pending?'复核中':review&&!current?'图片已变化':current&&review?.state==='complete'?review.result?.verdict==='passed'?'已通过':'需调整':'检查图片密度与排版'}</span></summary><div><p>Codex 读取整张成品和指标区域图，检查文字堆积、溢出、Logo 与可读性；不重新采集或改写行情。</p><button className="secondary-button workspace-button" disabled={busy||!!pending||!card||card.state!=='ready'||dirty||!imageHash} onClick={()=>void start()}><RefreshCw size={14} className={pending?'spin':''}/>{pending?'正在视觉复核…':'Codex 视觉复核'}</button>{(!card||dirty)&&<small>请先完成采集并保存本次卡片。</small>}{error&&<p role="alert">{error}</p>}{review&&<p>{current||pending?review.message:'当前图片与上次复核版本不同，请重新复核。'}</p>}{current&&review?.result&&<><p>{review.result.summary}</p><ul>{review.result.issues.map((issue,index)=><li key={index}><strong>{issue.area}：</strong>{issue.message}<small>{issue.suggestion}</small></li>)}</ul></>}</div></details>
}
