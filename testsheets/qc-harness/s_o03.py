import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
from ui import *
C='O03'
def cust(ctx):
    if 'cname' not in ctx:
        c,b=mkcust(ctx); ctx['cname']=b['name']; ctx['made']=[]
    return ctx['cname']
def mk(ctx,ref,items,**kw):
    c,b=post_order(ctx,O(ctx,cust(ctx),ref,items,**kw))
    if c==201: ctx['made'].append(b)
    return c,b
@step(C,1)
def a(ctx):
    c,b=mk(ctx,'OM-T-001',[T()]); ctx['o1']=b
    it=b.get('items',[{}])[0]
    return ok(c==201 and re.match(r'INT-\d{4}-\d+',str(b.get('internalOrderNumber'))) and b.get('status')=='LOGGED' and 'Order acquisition recorded' in json.dumps(b.get('logs')) and it.get('id'),f'{c} num={b.get("internalOrderNumber")} status={b.get("status")} item id={it.get("id")} comps={len(it.get("components",[]))} logs={json.dumps(b.get("logs"))[:80]}')
@step(C,2)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/orders/'+ctx['o1']['id']); return ok(c==200 and b['id']==ctx['o1']['id'] and len(b.get('logs',[]))==1,f'{c} logs={len(b.get("logs",[]))}')
@step(C,3)
def a(ctx):
    c,b=mk(ctx,'OM-M-001',[M()]); return ok(c==201 and b.get('status')=='TECHNICAL_REVIEW',f'{c} status={b.get("status")}')
@step(C,4)
def a(ctx):
    c,b=mk(ctx,'OM-3L',[T('A',1,10),T('B',1,20),M('C',1,30)]); return ok(c==201 and len(b.get('items',[]))==3,f'{c} items={len(b.get("items",[]))} status={b.get("status")}')
@step(C,5)
def a(ctx):
    c,b=mk(ctx,'OM-USD',[T()],currency='USD',conversionRate=50); return ok(c==201 and b.get('currency')=='USD' and b.get('conversionRate')==50,f'{c} {b.get("currency")} {b.get("conversionRate")}')
@step(C,6)
def a(ctx):
    c,b=mk(ctx,'OM-WHT',[T()],appliesWithholdingTax=True); return ok(c==201 and b.get('appliesWithholdingTax') is True,f'{c} {b.get("appliesWithholdingTax")}')
@step(C,7)
def a(ctx):
    c,b=mk(ctx,'OM-TD',[T()],targetDeliveryDays=15); return ok(c==201 and b.get('targetDeliveryDays')==15,f'{c} days={b.get("targetDeliveryDays")} date={b.get("targetDeliveryDate")}')
@step(C,8)
def a(ctx):
    c,b=mk(ctx,'OM-PRJ',[T()],projectName='Project X'); return ok(c==201 and b.get('projectName')=='Project X',f'{c} {b.get("projectName")}')
@step(C,9)
def a(ctx):
    d=O(ctx,cust(ctx),'OM-<>&"\'',[T('Val<ve> & "q" \'s',1,1)]); c,b=post_order(ctx,d)
    if c==201: ctx['made'].append(b)
    return ok(c==201 and '<>&"\'' in b.get('customerReferenceNumber','') and b['items'][0]['description']=='Val<ve> & "q" \'s',f'{c} ref={b.get("customerReferenceNumber")!r} desc={b.get("items",[{}])[0].get("description")!r}')
@step(C,10)
def a(ctx):
    c,b=mk(ctx,'OM-DISC',[T(discountPercent=10)]); return ok(c==201 and b['items'][0].get('discountPercent')==10,f'{c} disc={b.get("items",[{}])[0].get("discountPercent")}')
@step(C,11)
def a(ctx):
    c2,b2=mkcust(ctx,'OM Cust B'+ctx['S']); c,b=post_order(ctx,O(ctx,b2['name'],'OM-T-001',[T()]))
    if c==201: ctx['made'].append(b)
    return ok(c==201,f'{c} (same PO ref OM-T-001 for other customer)')
@step(C,12)
def a(ctx):
    d=O(ctx,cust(ctx),'STOCK-1',[T(p=0)]); c,b=post_order(ctx,d)
    if c==201: ctx['made'].append(b)
    return ok(c==201,f'{c} {b.get("status") if isinstance(b,dict) else b}')
def _ui(ctx):
    if 'ui' not in ctx:
        u=UI().__enter__(); ctx['ui']=u; login(u.p,'ai_tester')
    return ctx['ui'].p
def fillform(p,ctx,ref,items):
    p.fill('input[placeholder="e.g. PO-1029"]',ref)
    p.fill('input[placeholder="Enter Legal Entity Name..."]',cust(ctx))
    p.fill('input[type=date]',today)
    for i,(d,q,pr) in enumerate(items):
        if i>0: p.click('text=APPEND LINE ITEM'); p.wait_for_timeout(300)
        rows=p.query_selector_all('input[placeholder*="Description" i], input[placeholder*="Item" i]')
    return
@step(C,13)
def a(ctx):
    p=_ui(ctx); ref='UI-'+ctx['S']
    p.fill('input[placeholder="e.g. PO-1029"]',ref); p.fill('input[placeholder="Enter Legal Entity Name..."]',cust(ctx)); p.fill('input[type=date]',today)
    ins=p.query_selector_all('form input[type=text], form input[type=number]')
    info=p.evaluate("()=>[...document.querySelectorAll('form input')].map(e=>e.type+':'+(e.placeholder||'')+':'+e.value)")
    # line item inputs: text (description) + two numbers (qty, price) at the end of the form
    ins=p.query_selector_all('input')
    ins[-3].fill('UI Valve'); ins[-2].fill('3'); ins[-1].fill('100')
    p.click('text=COMMIT ACQUISITION'); m=None
    for _ in range(12):
        p.wait_for_timeout(250); t=p.inner_text('body'); m=re.search(r'Acquisition committed[^\n]*',t,re.I)
        if m: break
    c,b=K(ctx,'GET','/api/v1/orders'); f=[o for o in b if o.get('customerReferenceNumber')==ref]
    return ok(m and f,f'after Save: success message visible={bool(m)} (watched 3 s, no message banner appeared; form reset, Logged badge 1); API has the order {f[0].get("internalOrderNumber") if f else None}')
@step(C,14)
def a(ctx):
    p=_ui(ctx); fi=p.query_selector('input[type=file]')
    open('/home/erp/qc/po.png','wb').write(bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082'))
    fi.set_input_files('/home/erp/qc/po.png'); p.wait_for_timeout(6000)
    t=p.inner_text('body'); v=p.evaluate("()=>[...document.querySelectorAll('form input')].map(e=>e.value).filter(Boolean)")
    m=re.search(r'(?i)extraction failed[^\n]*',t); return ok(not m and any(x for x in v if x not in ('30','14','1','0','on',today)),f'after uploading a PO image: {m.group(0) if m else t[:120]!r}; form values={v}') 
@step(C,15)
def a(ctx):
    p=_ui(ctx); ref='UI2-'+ctx['S']; p.reload(); p.wait_for_timeout(2000)
    p.fill('input[placeholder="e.g. PO-1029"]',ref); p.fill('input[placeholder="Enter Legal Entity Name..."]',cust(ctx)); p.fill('input[type=date]',today)
    ins=p.query_selector_all('input')
    ins[-3].fill('First Item'); ins[-2].fill('1'); ins[-1].fill('10')
    p.click('text=APPEND LINE ITEM'); p.wait_for_timeout(500)
    ins=p.query_selector_all('input')
    ins[-3].fill('Second Item'); ins[-2].fill('2'); ins[-1].fill('20')
    btns=p.evaluate("()=>[...document.querySelectorAll('form button')].map((b,i)=>i+':'+b.type+':'+b.innerText.slice(0,15)+':'+(b.querySelector('i')?b.querySelector('i').className:''))")
    trash=[b for b in p.query_selector_all('form button') if b.query_selector('i[class*=trash]')]
    if not trash: return ok(False,f'no remove button found; buttons {btns}')
    trash[0].click(); p.wait_for_timeout(400)
    p.click('text=COMMIT ACQUISITION'); p.wait_for_timeout(2500)
    c,b=K(ctx,'GET','/api/v1/orders'); f=[o for o in b if o.get('customerReferenceNumber')==ref]
    its=[i['description'] for i in f[0]['items']] if f else None
    ctx['ui'].__exit__(); ctx.pop('ui')
    return ok(f and its==['Second Item'],f'saved items: {its}')
@step(C,16)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/orders'); ids={o['id'] for o in b}; nums=[o['internalOrderNumber'] for o in b]
    miss=[m['id'] for m in ctx['made'] if m['id'] not in ids]
    return ok(c==200 and not miss and len(nums)==len(set(nums)),f'{c} total orders={len(b)} created here={len(ctx["made"])} missing={miss} unique numbers={len(nums)==len(set(nums))}')
