// Hide the console window on a Windows release build. Stdio targets macOS only.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    stdio_desktop_lib::run()
}
