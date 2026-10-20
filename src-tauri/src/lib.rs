use std::fs;
use tauri::Manager;

#[tauri::command]
fn load_app_config(app: tauri::AppHandle) -> Result<String, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let path = dir.join("config.json");
  if !path.exists() {
    return Ok(String::new());
  }
  fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_app_config(app: tauri::AppHandle, contents: String) -> Result<(), String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let path = dir.join("config.json");
  fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![load_app_config, save_app_config])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
