; 卸载时清掉「桌面右键菜单显示」这一项注册表
; （只有用户手动开过才存在，删不到也不报错）
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\DesktopBackground\Shell\WeatherWidget"
!macroend
