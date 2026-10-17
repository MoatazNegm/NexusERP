import os,sys
sys.path.insert(0,'/home/topstor/pw/py')
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/home/topstor/pw/browsers'
from playwright.sync_api import sync_playwright
class UI:
    def __enter__(self):
        self.pw=sync_playwright().start(); self.b=self.pw.chromium.launch(); self.p=self.b.new_page(viewport={'width':1400,'height':900}); return self
    def __exit__(self,*a): self.b.close(); self.pw.stop()
def login(p,user,pw='Nexus#Test2026',env=None):
    p.goto('http://localhost:5005/'); p.wait_for_timeout(1500)
    p.fill('input[type=text]',user)
    p.wait_for_timeout(800)
    p.fill('input[type=password]',pw)
    p.click('button')
    p.wait_for_timeout(3000)
