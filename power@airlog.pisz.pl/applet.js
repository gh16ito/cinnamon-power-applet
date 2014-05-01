const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const DBus = imports.dbus;
const Lang = imports.lang;
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;
const Pango = imports.gi.Pango;
const Main = imports.ui.main;
const Settings = imports.ui.settings;

const BUS_NAME = 'org.cinnamon.SettingsDaemon';
const OBJECT_PATH = '/org/cinnamon/SettingsDaemon/Power';

const UPDeviceType = {
    UNKNOWN: 0,
    AC_POWER: 1,
    BATTERY: 2,
    UPS: 3,
    MONITOR: 4,
    MOUSE: 5,
    KEYBOARD: 6,
    PDA: 7,
    PHONE: 8,
    MEDIA_PLAYER: 9,
    TABLET: 10,
    COMPUTER: 11
};

const UPDeviceState = {
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6
};

const SettingsManagerInterface = {
	name: 'org.freedesktop.DBus.Properties',
	methods: [
		{ name: 'GetAll', inSignature: 's', outSignature: 'a{sv}' }
	],
	signals: [
	{name: 'PropertiesChanged', inSignature:'s,a{sv},a[s]', outSignature:''}
	]
};

let SettingsManagerProxy = DBus.makeProxyClass(SettingsManagerInterface);

const DisplayDeviceInterface = <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="TimeToEmpty" type="x" access="read"/>
    <property name="TimeToFull" type="x" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="IconName" type="s" access="read"/>
    </interface>;
let DisplayDeviceProxy = Gio.DBusProxy.makeProxyWrapper(DisplayDeviceInterface);

function DeviceItem() {
    this._init.apply(this, arguments);
}

DeviceItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function(device) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this, { reactive: false });

        let [device_id, device_type, icon, percentage, state, time, timepercentage] = device;

        this._box = new St.BoxLayout({ style_class: 'popup-device-menu-item' });
        this._label = new St.Label({ text: this._deviceTypeToString(device_type) });

        this._icon = new St.Icon({ gicon: Gio.icon_new_for_string(icon),
                                   icon_type: St.IconType.SYMBOLIC,
                                   style_class: 'popup-menu-icon' });

        this._box.add_actor(this._icon);
        this._box.add_actor(this._label);
        this.addActor(this._box);

        let percentLabel = new St.Label({ text: C_("percent of battery remaining", "%d%%").format(Math.round(percentage)) });
        this.addActor(percentLabel, { align: St.Align.END });
    },

    _deviceTypeToString: function(type) {
        switch (type) {
            case UPDeviceType.AC_POWER:
                return _("AC adapter");
            case UPDeviceType.BATTERY:
                return _("Laptop battery");
            case UPDeviceType.UPS:
                return _("UPS");
            case UPDeviceType.MONITOR:
                return _("Monitor");
            case UPDeviceType.MOUSE:
                return _("Mouse");
            case UPDeviceType.KEYBOARD:
                return _("Keyboard");
            case UPDeviceType.PDA:
                return _("PDA");
            case UPDeviceType.PHONE:
                return _("Cell phone");
            case UPDeviceType.MEDIA_PLAYER:
                return _("Media player");
            case UPDeviceType.TABLET:
                return _("Tablet");
            case UPDeviceType.COMPUTER:
                return _("Computer");
            default:
                return _("Unknown");
        }
    }
}

function MyApplet(metadata, orientation, panel_height, instanceId) {
    this._init(metadata, orientation, panel_height, instanceId);
}


MyApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    _init: function(metadata, orientation, panel_height, instanceId) {        
        Applet.TextIconApplet.prototype._init.call(this, orientation, panel_height);
        
        try {
            this.metadata = metadata;

            this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
            this.settings.bindProperty(Settings.BindingDirection.IN, "labelinfo", "labelinfo", this._updateLabel, null);
            
            Main.systrayManager.registerRole("power", metadata.uuid);
            Main.systrayManager.registerRole("battery", metadata.uuid);
            
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.menu = new Applet.AppletPopupMenu(this, orientation);
            this.menuManager.addMenu(this.menu);            
            
            //this.set_applet_icon_symbolic_name('battery-missing');            
            this._proxy = new DisplayDeviceProxy(Gio.DBus.system,
            		'org.freedesktop.UPower',
            		'/org/freedesktop/UPower/devices/DisplayDevice',
            		Lang.bind(this, function (proxy, error) {
            			this._proxy.connect('g-properties-changed', Lang.bind(this, this._sync));
            			this._sync();
            		}));
            this._smProxy = new SettingsManagerProxy(DBus.session, BUS_NAME, OBJECT_PATH);
            
            let icon = this.actor.get_children()[0];
            this.actor.remove_actor(icon);
            let box = new St.BoxLayout({ name: 'batteryBox' });
            this.actor.add_actor(box);
            let iconBox = new St.Bin();
            box.add(iconBox, { y_align: St.Align.MIDDLE, y_fill: false });
            this._mainLabel = new St.Label();
            this._mainLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            box.add(this._mainLabel, { y_align: St.Align.MIDDLE, y_fill: false });
            iconBox.child = icon;

            this._deviceItems = [ ];
            this._hasPrimary = false;
            this._primaryDeviceId = null;
            
            let applet = this;

            this._batteryItem = new PopupMenu.PopupMenuItem('', { reactive: false });
            this._primaryPercentage = new St.Label();
            this._batteryItem.addActor(this._primaryPercentage, { align: St.Align.END });
            this.menu.addMenuItem(this._batteryItem);

            this._otherDevicePosition = 1;
            
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addSettingsAction(_("Power Settings"), 'power');

            this._smProxy.connect('PropertiesChanged', Lang.bind(this, this._devicesChanged));           
        }
        catch (e) {
            global.logError(e);
        }
    },
    
    _getDevice: function () {
        return [1, this._proxy.Type, this._proxy.IconName, this._proxy.Percentage, this._proxy.State, this._getSeconds()]
    },
    
    _getSeconds: function () {
        return this._proxy.TimeToEmpty;
    },
    
    _sync: function () {
        this._devicesChanged();
    },
    
    on_applet_clicked: function(event) {
        this.menu.toggle();        
    },
    
    _readPrimaryDevice: function() {
        var device = this._getDevice();
        global.logError(device);

        let [device_id, device_type, icon, percentage, state, seconds] = device;
        if (device_type == UPDeviceType.BATTERY) {
            this._hasPrimary = true;
            let time = Math.round(seconds / 60);
            if (time == 0) {
                // 0 is reported when UPower does not have enough data
                // to estimate battery life
                this._batteryItem.label.text = _("Estimating...");
            } else {
                let minutes = time % 60;
                let hours = Math.floor(time / 60);
                let timestring;
                if (time > 60) {
                    if (minutes == 0) {
                        timestring = ngettext("%d hour remaining", "%d hours remaining", hours).format(hours);
                    } else {
                        let template = _("%d %s %d %s remaining");
                        timestring = template.format (hours, ngettext("hour", "hours", hours), minutes, ngettext("minute", "minutes", minutes));
                    }
                } else timestring = ngettext("%d minute remaining", "%d minutes remaining", minutes).format(minutes);
                this._batteryItem.label.text = timestring;
                this.set_applet_tooltip(timestring);
            }
                this._primaryPercentage.text = C_("percent of battery remaining", "%d%%").format(Math.round(percentage));
                this._batteryItem.actor.show();
        } else {
            this._hasPrimary = false;
            this._batteryItem.actor.hide();
        }
        this._primaryDeviceId = device_id;
    },

    on_panel_height_changed: function() {
        this._devicesChanged();
    },

    _devicesChanged: function() {           
        let icon = this._proxy.IconName;
        if (icon) {    
            this.set_applet_icon_symbolic_name('battery-missing');
            let gicon = Gio.icon_new_for_string(icon);
            this._applet_icon.gicon = gicon;
            this.actor.show();
        } else {
            this.menu.close();
            this.actor.hide();
        }

        this._readPrimaryDevice();
        this._updateLabel();
    },
    
    _updateLabel: function() {
        var device = this._getDevice();
        if (this.labelinfo != "nothing") {
            let [device_id, device_type, icon, percentage, state, time] = device;
            let labelText = "";

            if (this.labelinfo == "percentage" || time == 0) {
                labelText = C_("percent of battery remaining", "%d%%").format(Math.round(percentage));
            }
            else if (this.labelinfo == "time") {
                let seconds = Math.round(time / 60);
                let minutes = Math.floor(seconds % 60);
                let hours = Math.floor(seconds / 60);
                labelText = C_("time of battery remaining", "%d:%02d").format(hours,minutes);
            }
            else if (this.labelinfo == "percentage_time") {
                let seconds = Math.round(time / 60);
                let minutes = Math.floor(seconds % 60);
                let hours = Math.floor(seconds / 60);
                labelText = C_("percent of battery remaining", "%d%%").format(Math.round(percentage)) + " (" +
                        C_("time of battery remaining", "%d:%02d").format(hours,minutes) + ")";
            }

            this._mainLabel.set_text(labelText);
            return;
        }
        // Display disabled or no battery found... hot-unplugged?
        this._mainLabel.set_text("");
    },
    
    on_applet_removed_from_panel: function() {
        Main.systrayManager.unregisterId(this.metadata.uuid);
    }
};

function main(metadata, orientation, panel_height, instanceId) {  
    let myApplet = new MyApplet(metadata, orientation, panel_height, instanceId);
    return myApplet;      
}
