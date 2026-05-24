@echo off
set count=1000
set SRC=C:\Users\Moata\.gemini\antigravity\brain\96715c2f-1698-4ecd-91c5-b077acd1c354\.system_generated\click_feedback
set DEST=C:\Users\Moata\.gemini\antigravity\brain\96715c2f-1698-4ecd-91c5-b077acd1c354\scratch\frames_v6
for /f "tokens=*" %%a in ('dir /b /o:n %SRC%\click_feedback_1778761*.png') do (
    set /a count+=1
    copy "%SRC%\%%a" "%DEST%\f_!count:~1!.png"
)
