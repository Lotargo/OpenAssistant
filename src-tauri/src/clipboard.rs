//! Explicit journal copying. Clipboard contents are never read by the app.
use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    if text.len() > 16 * 1024 * 1024 {
        return Err("Журнал слишком большой для копирования.".into());
    }
    if text.is_empty() {
        return Err("Журнал пуст.".into());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|_| "Не удалось скопировать журнал в буфер обмена. Повторите попытку.".into())
}
