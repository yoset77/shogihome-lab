#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Native desktop shell; the headless backend remains independently testable.
mod app;
mod editor;
mod launcher;
mod shutdown;
mod state;
mod tray;

fn main() {
    app::run();
}
