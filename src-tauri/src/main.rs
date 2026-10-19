// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Code invokes this same binary for its statusLine and hooks; those
    // calls must answer fast and never start the GUI.
    if let Some(code) = termcode_lib::agents::run_cli() {
        std::process::exit(code);
    }
    termcode_lib::run()
}
