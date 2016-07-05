/* globals $, app, socket, require, define */

define('admin/plugins/sso-vbulletin', ['settings'], function(Settings) {
    'use strict';

    var ACP = {};

    ACP.init = function() {
        console.log('sso-vbulletin');
        Settings.load('sso-vbulletin', $('.sso-vbulletin-settings'));

        $('#save').on('click', function() {
            console.log('clicked');
            Settings.save('sso-vbulletin', $('.sso-vbulletin-settings'), function() {
                console.log('saved');
                app.alert({
                    type: 'success',
                    alert_id: 'sso-vbulletin-saved',
                    title: 'Settings Saved',
                    message: 'Please reload your NodeBB to apply these settings',
                    clickfn: function() {
                        socket.emit('admin.reload');
                    }
                });
            });
        });
    };

    return ACP;
});