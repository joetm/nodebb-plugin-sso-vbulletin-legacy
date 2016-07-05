/* globals module, require */
(function(module) {
    'use strict';

    var user = module.parent.require('./user'),
        meta = module.parent.require('./meta'),
        db = module.parent.require('../src/database'),
        passport = module.parent.require('passport'),
        passportVB = require('passport-local').Strategy,
        nconf = module.parent.require('nconf'),
        async = module.parent.require('async'),
        winston = module.parent.require('winston');

    var authenticationController = module.parent.require('./controllers/authentication');

    var constants = Object.freeze({
        'name': 'vBulletin',
        'admin': {
            'route': '/plugins/sso-vbulletin',
            'icon': 'fa-cp-square'
        }
    });

    var VB = {
        settings: undefined
    };

    VB.init = function(params, callback) {
        function render(req, res) {
            res.render('admin/plugins/sso-vbulletin', {});
        }
        params.router.get('/admin/plugins/sso-vbulletin', params.middleware.admin.buildHeader, render);
        params.router.get('/api/admin/plugins/sso-vbulletin', render);
        callback();
    };

    VB.getSettings = function(callback) {
        if (VB.settings) {
            return callback();
        }
        meta.settings.get('sso-vbulletin', function(err, settings) {
            VB.settings = settings;
            callback();
        });
    }

    VB.getStrategy = function(strategies, callback) {
        if (!VB.settings) {
            return VB.getSettings(function() {
                VB.getStrategy(strategies, callback);
            });
        }

        if (
            VB.settings !== undefined
            // && VB.settings.hasOwnProperty('app_id') && VB.settings.app_id
            // && VB.settings.hasOwnProperty('secret') && VB.settings.secret
        ) {
            passport.use(new passportVB({
                // TODO
                clientID: VB.settings.app_id,
                clientSecret: VB.settings.secret,
                callbackURL: nconf.get('url') + '/auth/vbulletin/callback',
                passReqToCallback: true,
                profileFields: ['id', 'emails', 'name', 'displayName']
            }, function(req, accessToken, refreshToken, profile, done) {
                if (req.hasOwnProperty('user') && req.user.hasOwnProperty('uid') && req.user.uid > 0) {
                    // Save vbulletin-specific information to the user
                    user.setUserField(req.user.uid, 'vbid', profile.id);
                    db.setObjectField('vbid:uid', profile.id, req.user.uid);
                    return done(null, req.user);
                }

                var email;
                if (profile._json.hasOwnProperty('email')) {
                    email = profile._json.email;
                } else {
                    email = (profile.username ? profile.username : profile.id) + '@facebook.com';
                }

                VB.login(profile.id, profile.displayName, email, 'https://graph.facebook.com/' + profile.id + '/picture?type=large', accessToken, refreshToken, profile, function(err, user) {
                    if (err) {
                        return done(err);
                    }

                    // Require collection of email
                    if (email.endsWith('@facebook.com')) {
                        req.session.registration = req.session.registration || {};
                        req.session.registration.uid = user.uid;
                        req.session.registration.vbid = profile.id;
                    }

                    authenticationController.onSuccessfulLogin(req, user.uid);
                    done(null, user);
                });
            }));

            strategies.push({
                name: 'vbulletin',
                url: '/auth/vbulletin',
                callbackURL: '/auth/vbulletin/callback',
                icon: constants.admin.icon,
                scope: 'email, user_friends'
            });
        }

        callback(null, strategies);
    };

    VB.getAssociation = function(data, callback) {
        user.getUserField(data.uid, 'vbid', function(err, vbId) {
            if (err) {
                return callback(err, data);
            }

            if (vbId) {
                data.associations.push({
                    associated: true,
                    url: 'https://facebook.com/' + vbId,
                    name: constants.name,
                    icon: constants.admin.icon
                });
            } else {
                data.associations.push({
                    associated: false,
                    url: nconf.get('url') + '/auth/vbulletin',
                    name: constants.name,
                    icon: constants.admin.icon
                });
            }

            callback(null, data);
        })
    };

    VB.prepareInterstitial = function(data, callback) {
        if (data.userData.hasOwnProperty('uid') && data.userData.hasOwnProperty('vbid')) {
            user.getUserField(data.userData.uid, 'email', function(err, email) {
                if (email.endsWith('@facebook.com')) {
                    data.interstitials.push({
                        template: 'partials/sso-vbulletin/password.tpl',
                        data: {},
                        callback: VB.storeAdditionalData
                    });
                }

                callback(null, data);
            });
        } else {
            callback(null, data);
        }
    };

    VB.storeAdditionalData = function(userData, data, callback) {
        user.setUserField(userData.uid, 'email', data.email, callback);
    };

    VB.storeTokens = function(uid, accessToken, refreshToken) {
        //JG: Actually save the useful stuff
        winston.info("Storing received fb access information for uid(" + uid + ") accessToken(" + accessToken + ") refreshToken(" + refreshToken + ")");
        user.setUserField(uid, 'fbaccesstoken', accessToken);
        user.setUserField(uid, 'fbrefreshtoken', refreshToken);
    };

    VB.login = function(vbid, name, email, picture, accessToken, refreshToken, profile, callback) {

        winston.verbose("Facebook.login vbid, name, email, picture: " + vbid + ", " + ", " + name + ", " + email + ", " + picture);

        VB.getUidByVbid(vbid, function(err, uid) {
            if(err) {
                return callback(err);
            }
            if (uid !== null) {
                // Existing User
                VB.storeTokens(uid, accessToken, refreshToken);
                callback(null, {
                    uid: uid
                });
            } else {
                // New User
                var success = function(uid) {
                    // Save vbulletin-specific information to the user
                    user.setUserField(uid, 'vbid', vbid);
                    db.setObjectField('vbid:uid', vbid, uid);
                    var autoConfirm = VB.settings && VB.settings.autoconfirm === "on" ? 1: 0;
                    user.setUserField(uid, 'email:confirmed', autoConfirm);

                    // Save their photo, if present
                    if (picture) {
                        user.setUserField(uid, 'uploadedpicture', picture);
                        user.setUserField(uid, 'picture', picture);
                    }

                    VB.storeTokens(uid, accessToken, refreshToken);

                    callback(null, {
                        uid: uid
                    });
                };

                user.getUidByEmail(email, function(err, uid) {
                    if(err) {
                        return callback(err);
                    }

                    if (!uid) {
                        user.create({username: name, email: email}, function(err, uid) {
                            if(err) {
                                return callback(err);
                            }

                            success(uid);
                        });
                    } else {
                        success(uid); // Existing account -- merge
                    }
                });
            }
        });
    };

    VB.getUidByVbid = function(vbid, callback) {
        db.getObjectField('vbid:uid', vbid, function(err, uid) {
            if (err) {
                return callback(err);
            }
            callback(null, uid);
        });
    };

    VB.addMenuItem = function(custom_header, callback) {
        custom_header.authentication.push({
            'route': constants.admin.route,
            'icon': constants.admin.icon,
            'name': constants.name
        });

        callback(null, custom_header);
    };

    VB.deleteUserData = function(data, callback) {
        var uid = data.uid;

        async.waterfall([
            async.apply(user.getUserField, uid, 'vbid'),
            function(oAuthIdToDelete, next) {
                db.deleteObjectField('vbid:uid', oAuthIdToDelete, next);
            }
        ], function(err) {
            if (err) {
                winston.error('[sso-vbulletin] Could not remove OAuthId data for uid ' + uid + '. Error: ' + err);
                return callback(err);
            }
            callback(null, uid);
        });
    };

    module.exports = VB;
}(module));
