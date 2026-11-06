// A settings window of another extension, for the Settings check in
// tools/test-shell.sh.
import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ShotsHelperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        page.add(new Adw.PreferencesGroup({title: 'Test only'}));
        window.add(page);
    }
}
