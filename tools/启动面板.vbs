' Mail Fleet Panel - 启动（无任何黑色命令行窗口）
' 双击本文件即可：后台静默启动面板并自动打开浏览器
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
Set env = sh.Environment("Process")
If env("PANEL_SECRET") = "" Then env("PANEL_SECRET") = "please-change-this-secret"
If env("PORT") = "" Then env("PORT") = "3300"
' 参数 0 = 隐藏窗口；直接运行 exe，不经过 cmd
sh.Run Chr(34) & dir & "\mail-fleet-panel.exe" & Chr(34) & " panel.cjs", 0, False
WScript.Sleep 3000
sh.Run "http://127.0.0.1:3300"
