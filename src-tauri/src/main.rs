// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    {
        termcode_lib::harden_dll_search();
        termcode_lib::restore_ctrl_c();
    }
    #[cfg(target_os = "linux")]
    termcode_lib::avoid_blank_webview();
    // Claude Code invokes this same binary for its statusLine and hooks; those
    // calls must answer fast and never start the GUI.
    if let Some(code) = termcode_lib::agents::run_cli() {
        std::process::exit(code);
    }
    termcode_lib::run()
}
