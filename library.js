/* globals module, require */
(function(module) {
    'use strict';

    var user = module.parent.require('./user'),
        meta = module.parent.require('./meta'),
        db = module.parent.require('../src/database'),
        passport = module.parent.require('passport'),
        LocalStrategy = require('passport-local').Strategy,
        nconf = module.parent.require('nconf'),
        async = module.parent.require('async'),
        log = module.parent.require('winston'),
        md5 = module.parent.require('md5');

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

    // "hook": "static:app.load"
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

    // "hook": "filter:auth.init"
    VB.getStrategy = function(strategies, callback) {
        if (!VB.settings) {
            return VB.getSettings(function() {
                VB.getStrategy(strategies, callback);
            });
        }

        if (
            VB.settings !== undefined
            // && VB.settings.hasOwnProperty('db_table') && VB.settings.db_table
        ) {
            passport.use(new LocalStrategy({
                usernameField: 'username',
                passwordField: 'password',
                passReqToCallback: true,
                session: false
            },
              function(req, username, password, done) {

                // TODO
                User.findOne({username: username}, function (err, user) {
                  if (err) { return done(err); }
                  if (!user) { return done(null, false); }

                  if (md5(md5(password) + user.salt) !== user.password) {
                      return done(null, false);
                  }
                });

                // TODO
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

                var avatar = 'https://graph.facebook.com/' + profile.id + '/picture?type=large';
                var profilepic = 'https://graph.facebook.com/' + profile.id + '/picture?type=large';

                VB.login(profile.id, profile.displayName, email, avatar, profilepic, profile, function(err, user) {
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

              }
            ));

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

    // "hook": "filter:auth.list"
    VB.getAssociation = function(data, callback) {
        user.getUserField(data.uid, 'vbid', function(err, vbId) {
            if (err) {
                return callback(err, data);
            }

            if (vbId) {
                data.associations.push({
                    associated: true,
                    url: 'https://TODO.com/' + vbId,
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

    // "hook": "filter:register.interstitial"
    VB.prepareInterstitial = function(data, callback) {
        if (data.userData.hasOwnProperty('uid') && data.userData.hasOwnProperty('vbid')) {
            // show the interstitial to vb users
            user.getUserField(data.userData.uid, 'username', function(err, username) {
                data.interstitials.push({
                    template: 'partials/sso-vbulletin/password.tpl',
                    data: {username},
                    callback: VB.storeAdditionalData
                });
            });
            callback(null, data);
        } else {
            callback(null, data);
        }
    };

    VB.storeAdditionalData = function(userData, data, callback) {
        // TODO: save the password of this user in NodeBB








        // user.setUserField(userData.uid, 'password', data.password, callback);
    };

    // VB.storeTokens = function(uid, accessToken, refreshToken) {
    //     log.info("Storing received fb access information for uid(" + uid + ") accessToken(" + accessToken + ") refreshToken(" + refreshToken + ")");
    //     user.setUserField(uid, 'fbaccesstoken', accessToken);
    //     user.setUserField(uid, 'fbrefreshtoken', refreshToken);
    // };

    VB.login = function(vbid, name, email, avatar, profilepic, profile, callback) {

        log.verbose("VB.login vbid, name, email, avatar: " + vbid + ", " + ", " + name + ", " + email + ", " + avatar);

        VB.getUidByVbid(vbid, function(err, uid) {
            if(err) {
                return callback(err);
            }
            if (uid !== null) {
                // Existing User
                // VB.storeTokens(uid, accessToken, refreshToken);
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
                    if (avatar) {
                        user.setUserField(uid, 'uploadedpicture', avatar);
                        user.setUserField(uid, 'picture', avatar);
                    }

                    // VB.storeTokens(uid, accessToken, refreshToken);

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

    // OK
    VB.getUidByVbid = function(vbid, callback) {
        db.getObjectField('vbid:uid', vbid, function(err, uid) {
            if (err) {
                return callback(err);
            }
            callback(null, uid);
        });
    };

    // "hook": "filter:admin.header.build"
    VB.addMenuItem = function(custom_header, callback) {
        custom_header.authentication.push({
            'route': constants.admin.route,
            'icon': constants.admin.icon,
            'name': constants.name
        });

        callback(null, custom_header);
    };

	// "hook": "static:user.delete"
    VB.deleteUserData = function(data, callback) {
        var uid = data.uid;

        async.waterfall([
            async.apply(user.getUserField, uid, 'vbid'),
            function(oAuthIdToDelete, next) {
                db.deleteObjectField('vbid:uid', oAuthIdToDelete, next);
            }
        ], function(err) {
            if (err) {
                log.error('[sso-vbulletin] Could not remove OAuthId data for uid ' + uid + '. Error: ' + err);
                return callback(err);
            }
            callback(null, uid);
        });
    };

    module.exports = VB;
}(module));
