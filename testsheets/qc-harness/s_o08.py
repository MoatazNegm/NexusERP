import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
from ui import *
import subprocess
C='O08'
def seed(ctx):
    if 'ids' not in ctx:
        c,b=mkcust(ctx); ctx['cname']=b['name']; ctx['ids']=[]
        for i in range(10):
            c,o=post_order(ctx,O(ctx,ctx['cname'],f'LST-{i}',[T()] if i%2 else [M()])); ctx['ids'].append(o['id'])
@step(C,1)
def a(ctx):
    seed(ctx); c,b=K(ctx,'GET','/api/v1/orders'); f=['id','customerName','customerReferenceNumber','internalOrderNumber','status','items','logs']
    miss=[k for k in f if not all(k in o for o in b)] if isinstance(b,list) else f
    ctx['n']=len(b); return ok(c==200 and isinstance(b,list) and not miss,f'{c} count={len(b)} missing={miss}')
@step(C,2)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/orders?status=NOPE'); return ok(c==200 and len(b)==ctx['n'],f'{c} count={len(b)} (all={ctx["n"]}) filter ignored')
@step(C,3)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/orders?limit=2&page=1'); return ok(c==200 and len(b)==ctx['n'],f'{c} count={len(b)} (all={ctx["n"]}) paging ignored')
@step(C,4)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/orders?customerName=nobody'); return ok(c==200 and len(b)==ctx['n'],f'{c} count={len(b)} (all={ctx["n"]}) ignored')
@step(C,5)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/orders/'+ctx['ids'][0]); extra=[k for k in b if k not in('id',)]
    return ok(c==200 and b.get('id')==ctx['ids'][0],f'{c} id ok; keys={sorted(b)[:40]}')
@step(C,6)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/reports/orders'); f=['count','totalRevenue','totalRealCost','grossProfit','profitMarginPct','orders']
    return ok(c==200 and all(k in b for k in f),f'{c} keys={[k for k in f if k in b]} count={b.get("count")}')
@step(C,7)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/procurement/unique-po-number'); return ok(c==200 and re.match(r'PO-\d{4}-\d+',str(b.get('poNumber'))),f'{c} {b}')
@step(C,8)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/user-guide?format=markdown'); return ok(c==200 and len(str(b))>50,f'{c} len={len(str(b))} start={str(b)[:60]!r}')
def ui_logged(ctx):
    if 'ui' not in ctx:
        u=UI().__enter__(); ctx['ui']=u; login(u.p,'ai_tester')
    p=ctx['ui'].p; p.click('text=LOGGED ORDERS'); p.wait_for_timeout(1500); return p
@step(C,9)
def a(ctx):
    p=ui_logged(ctx); s=p.query_selector('input[placeholder^="Search"]')
    if not s: return ok(False,'no search box found in Logged tab; inputs='+str([i.get_attribute('placeholder') for i in p.query_selector_all('input')]))
    s.fill('LST-3'+ctx['S']); p.wait_for_timeout(800); t=p.inner_text('body')
    return ok('LST-3'+ctx['S'] in t and 'LST-4'+ctx['S'] not in t,f'search LST-3: contains LST-3={"LST-3"+ctx["S"] in t}, contains LST-4={"LST-4"+ctx["S"] in t}')
@step(C,10)
def a(ctx):
    p=ctx['ui'].p; labs=[x.inner_text().strip() for x in p.query_selector_all('button') if re.match(r'(ALL|TRADE|MANUFACTURING|BLANKET|STOCK) \(\d+\)',x.inner_text().strip())]
    if not labs: return ok(False,'no type filter buttons')
    res={}
    s_=p.query_selector('input[placeholder^="Search"]')
    if s_: s_.fill(''); p.wait_for_timeout(500)
    for l in labs:
        p.click(f'button:has-text("{l}")'); p.wait_for_timeout(500); res[l]=len(p.query_selector_all('text=RESUME RECORD'))
    good=all(int(re.search(r'\((\d+)\)',l).group(1))==n for l,n in res.items())
    p.click(f'button:has-text("{labs[0]}")'); p.wait_for_timeout(300)
    return ok(good and len(labs)>=4,f'filter buttons {labs}; rows per filter={res}; (no separate "standard" filter; Logged list holds LOGGED orders only)')
@step(C,11)
def a(ctx):
    p=ctx['ui'].p; s=p.query_selector('input[placeholder^="Search"]'); s.fill(''); p.wait_for_timeout(500)
    def col(): return [r.inner_text().split('\n')[0] for r in p.query_selector_all('tbody tr')][:10]
    before=col(); hs=p.query_selector_all('th')
    if not hs: return ok(False,'no table headers')
    hs[0].click(); p.wait_for_timeout(500); a1=col(); hs[0].click(); p.wait_for_timeout(500); a2=col()
    return ok(a1==sorted(a1) and a2==sorted(a2,reverse=True),f'asc={a1[:4]} desc={a2[:4]}')
@step(C,12)
def a(ctx):
    p=ctx['ui'].p; p.click('text=RESUME RECORD'); p.wait_for_timeout(1500); t=p.inner_text('body').upper()
    has={'TRANSACTION LINE ITEMS':'TRANSACTION LINE ITEMS' in t,'LOG':bool(re.search(r'\\b(LOGS?|ACTIVITY|AUDIT|HISTORY)\\b',t)),'DELIVERY':bool(re.search(r'\\b(DELIVERIES|SHIPMENTS?|DELIVERED)\\b',t))}
    ctx['resumed']=True
    return ok(has['TRANSACTION LINE ITEMS'] and has['LOG'] and has['DELIVERY'],f'RESUME RECORD opens edit form (no OrderDetailsModal); visible sections {has}')
@step(C,13)
def a(ctx):
    p=ctx['ui'].p; btns=[(b.inner_text().strip(),b.get_attribute('title')) for b in p.query_selector_all('button')]
    pdf=[b for b in btns if 'PDF' in ((b[0] or '')+(b[1] or '')).upper() or 'EXPORT' in ((b[0] or '')+(b[1] or '')).upper() or 'PRINT' in ((b[0] or '')+(b[1] or '')).upper()]
    return ok(bool(pdf),f'on the resumed order (and Logged list) PDF/export controls={pdf}; buttons={[b[0] for b in btns]}')
@step(C,14)
def a(ctx):
    open('/home/erp/qc/pod.pdf','wb').write(b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
    r=subprocess.run(['curl','-s','-w','\n%{http_code}','-F','podFile=@/home/erp/qc/pod.pdf','-H','x-api-key: '+ctx['k'],NB+'/api/upload-pod'],capture_output=True,text=True).stdout
    return ok(r.strip().endswith('200') and '/uploads/pod' in r,f'{r[:200]!r}')
@step(C,15)
def a(ctx):
    try: ctx['ui'].__exit__()
    except Exception: pass
    with UI() as u:
        p=u.p; login(p,'ai_tester'); p.click('text=LOGGED ORDERS'); p.wait_for_timeout(1500)
        rows=len(p.query_selector_all('tbody tr')); lab=[x.inner_text().strip() for x in p.query_selector_all('button') if x.inner_text().strip().startswith('ALL (')]
    c,b=K(ctx,'GET','/api/v1/orders')
    n=len([o for o in b if o.get('status') in ('LOGGED','TECHNICAL_REVIEW','NEGATIVE_MARGIN')]); nl=len([o for o in b if o.get('status')=='LOGGED'])
    return ok(rows==n,f'UI Logged rows={rows} {lab}; API orders in LOGGED/TECHNICAL_REVIEW/NEGATIVE_MARGIN={n} (status LOGGED only={nl}; total {len(b)}): TECHNICAL_REVIEW orders are not listed in Logged')
