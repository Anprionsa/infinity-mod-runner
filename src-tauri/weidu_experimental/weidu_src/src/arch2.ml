let associate_these a = Var.set_string "WEIDU_ARCH" "amd64" ; Var.set_string "WEIDU_OS" "win32"; Var.set_string "WEIDU_VER" Version.version
let _ = associate_these ()
