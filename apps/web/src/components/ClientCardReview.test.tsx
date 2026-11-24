import {render,screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {expect,it,vi} from 'vitest'
import {api} from '../api'
import type {ServiceCard} from '../clientService'
import ClientCardReview from './ClientCardReview'

vi.mock('../api',()=>({api:vi.fn()}))
const card={id:'card',revision:2,state:'ready'} as ServiceCard
const review={id:'review',state:'complete',card_revision:2,image_hash:'old-image',message:'视觉复核通过。',result:{verdict:'passed',summary:'旧版检查通过',issues:[]}}

it('does not mark a changed image as passed and requires a saved card',async()=>{
 vi.mocked(api).mockResolvedValue({review})
 const {rerender}=render(<ClientCardReview card={card} dirty={false} imageHash="new-image"/>)
 await screen.findByText('图片已变化')
 expect(screen.queryByText('旧版检查通过')).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'Codex 视觉复核',hidden:true})).toBeEnabled()
 rerender(<ClientCardReview card={card} dirty={true} imageHash="new-image"/>)
 expect(screen.getByRole('button',{name:'Codex 视觉复核',hidden:true})).toBeDisabled()
})

it('only requests a model review after an explicit click',async()=>{
 const user=userEvent.setup()
 const result={...review,image_hash:'image',review_focus:['metrics','disclosure']}
 let submitted=false
 vi.mocked(api).mockImplementation(async(_,init)=>{
  if(init?.method==='POST'){submitted=true;return result}
  return {review:submitted?result:null}
 })
 render(<ClientCardReview card={card} dirty={false} imageHash="image"/>)
 await user.click(screen.getByText('成品视觉复核'))
 await user.click(screen.getByRole('checkbox',{name:'指标区'}))
 await user.click(screen.getByRole('checkbox',{name:'风险提示与落款'}))
 expect(vi.mocked(api).mock.calls.some(([,init])=>init?.method==='POST')).toBe(false)
 await user.click(screen.getByRole('button',{name:'Codex 视觉复核'}))
 const call=vi.mocked(api).mock.calls.find(([,init])=>init?.method==='POST')!
 expect(call[0]).toBe('/client-service/cards/card/review')
 expect(JSON.parse(String(call[1]?.body))).toMatchObject({expected_revision:2,review_focus:['metrics','disclosure']})
 expect(await screen.findByText('已提交检查重点 · 指标区、风险提示与落款')).toBeVisible()
})
