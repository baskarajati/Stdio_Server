/// Starts the Stdio desktop application.
///
/// The window loads the Stdio web app. SOL-5 adds the signing and the notarization.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Stdio desktop application");
}
