// The macOS menu bar: Tauri's standard menu, plus Check for Updates… under Openfield, right after
// About, where Mac apps keep it. Windows and Linux have no menu bar (the window draws its own title
// bar), so there Settings > Updates is the way in.

use tauri::{
    menu::{Menu, MenuEvent, MenuItem, MenuItemKind},
    AppHandle, Wry,
};

const CHECK_FOR_UPDATES: &str = "check-for-updates";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    // The first submenu is the one named after the app: About, Services, Hide, Quit.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let check = MenuItem::with_id(
            app,
            CHECK_FOR_UPDATES,
            "Check for Updates…",
            true,
            None::<&str>,
        )?;
        app_menu.insert(&check, 1)?;
    }
    Ok(menu)
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == CHECK_FOR_UPDATES {
        crate::updates::check_from_menu(app.clone());
    }
}
