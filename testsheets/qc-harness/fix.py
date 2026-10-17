import sys;sys.path.insert(0,'/home/erp/qc')
from lib import *
def resub(tid,no,res,comment):
    c,t=P('GET',f'/tests/{tid}'); sid=[s['id'] for s in t['steps'] if s['step_number']==no][0]
    print(P('DELETE',f'/test-results/{tid}/steps/{sid}')[0], P('POST',f'/test-results/{tid}/steps/{sid}',{'result':res,'comment':comment})[0])
if __name__=='__main__':
    resub(55,13,'fail',"Save in UI (tab New, PO UI-<S>, customer, 1 line item 3 x 100) created the order (API shows it, Logged badge 1) but NO success message 'Acquisition committed: PO # ... Internal ID ...' was ever displayed (DOM observed for 3 s, screenshots at 0.1/0.4/1 s). Expected message with the new internal order number not met.")
    resub(55,14,'fail',"Uploaded a PNG as PO file: UI shows 'EXTRACTION FAILED: GEMINI API KEY IS NOT CONFIGURED. PLEASE CHECK SETTINGS > AI CONFIGURATION.'; form not prefilled. Sheet says needs AI provider settings; none configured in the clean container, so expected symptom not met.")
    resub(55,15,'pass',"UI: added 2 line items (First Item, Second Item), removed the first with the trash button, saved; API order items = ['Second Item'] only. (Earlier fail was a tester-script selector error, re-run.)")
