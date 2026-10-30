' Mail Fleet Panel - stop background process
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c taskkill /F /IM mail-fleet-panel.exe", 0, False
