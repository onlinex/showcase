// SDK
const functions = require('firebase-functions');
const admin = require('firebase-admin');
// other
//const functionsHttps = require('../index.js').functionsHttps;
const functionCreate = require('../index.js').functionCreate;

///////////////////////////////////////////////////////////////////////////
///////////////////* User creation / deletion / update *///////////////////
///////////////////////////////////////////////////////////////////////////

// user created trigger
exports.onUserCreate = functionCreate.auth.user().onCreate((user) => {
    console.log("User created!", user.displayName);
    // promise user snapshot
    let promise_user = admin.firestore().collection('users').doc(user.uid);
    // set default firestore user variables
    return promise_user.set({
        attending: [], // list of attending events
        saved: [], // list of saved events
        authorities: {'self': 0}, // dict of permissions {'community_id' : 'authority_level', ..., ...]
        subscriptions: {
            //categories: [], // categories to wich a user is subscribed to
            configured: false, // weather user chose subscriptions
            communities: [] // community ids to wich a user is subscribed to
        },
        language: 'en', // set region
        email_active: true,
        user_rating: 0,
        cache_utc_sec: 0 // last time user cashed something
    }).then(() => {
        return admin.auth().updateUser(user.uid, {
            displayName: user.displayName || "Anonymous"
        });
    });
});

// user deleted trigger
exports.onUserDelete = functionCreate.auth.user().onDelete((user) => {
    // delete user from firestore
    admin.auth().revokeRefreshTokens(user.uid);
    // delete user from firestore
    return admin.firestore().collection('users').doc(user.uid).delete();
});

// trigger when user is deleted from firestore
exports.userDeleteTrigger = functionCreate.firestore.document('users/{userID}').onDelete((snap, context) => {
    // get provoker id
    let provoker_id = snap.id;

    return Promise.resolve().then(() => {
        // return all created events
        return admin.firestore().collection('events').where("creator_id", "==", provoker_id).get();
    }).then(querySnapshot => {
        // delete created events
        querySnapshot.forEach(doc => { doc.ref.delete(); });
        // return all user categories
        return admin.firestore().collection('users').doc(context.params.userID).collection('userCategories').get();
    }).then(querySnapshot => {
        querySnapshot.docs.forEach(doc => {
            doc.ref.delete();
        });
        return admin.firestore().collection('users').doc(context.params.userID).collection('userTickets').get();
    }).then(querySnapshot => {
        querySnapshot.docs.forEach(doc => {
            doc.ref.delete();
        });
        return Promise.resolve();
    }).catch(error => {
        console.log(error);
        return error;
    });
});


// Update user data
exports.userUpdateProfile = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }
    // define user id
    const userUID = context.auth.uid;
    // define messagin token
    const messagingTokenIOS = data.messaging_token_ios;

    if(messagingTokenIOS) {
        admin.firestore().collection('users').doc(userUID).update({
            'messaging_tokens.ios': messagingTokenIOS
        });
    }

    const displayName = data.display_name;
    const email = data.email;
    //
    let userObject = {};
    if(email) userObject.email = email;
    if(displayName) userObject.displayName = displayName;

    return admin.auth().updateUser(userUID, userObject).then(userRecord => {

        return {'status': 'ok', 'response': {
            'displayName': userRecord.displayName || "Anoynmous",
            'email'      : userRecord.email       || "",
            'disabled'   : userRecord.disabled    || false
        }};
    })
    .catch(error => {
        console.error(error);
        return error;
    });
});

///////////////////////////////////////////////////////////
///////////////////* User authorities *///////////////////
//////////////////////////////////////////////////////////

// send user notification
function userNotify(userID, object) {
    object['utc_sec'] = admin.firestore.Timestamp.now().seconds; // UTC/Unix timestamp
    return admin.firestore().collection('users').doc(userID).collection('notifications').add(object).then(() => {
        return Promise.resolve();
    });
}

// update user authorities
var userUpdatePermissions = exports.userUpdatePermissions = function(user_id, authority_id, level = 0) {
    // construct address for permission to change
    let address = "authorities." + authority_id.toString();
    // construct update object
    let updateObject = new Object();
    // delete if permission level is -1
    updateObject[address] = (level !== -1) ? level : admin.firestore.FieldValue.delete();
    // commit permissions
    return admin.firestore().collection('users').doc(user_id).update(updateObject);
}

// Verify / Check user is registered
exports.verifyUserRegistered = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }

    const provokerUID = context.auth.uid; // the intiator
    const userUID = data.user_id; // the user that is being checked
    const eventID = data.event_id;
    //
    async function getUserTicket() {
        const querySnapshot = await admin.firestore().collection('users').doc(userUID).collection('userTickets').where('event_id', '==', eventID).get();

        return {
            'exists': querySnapshot.size !== 0,
            'ticket': querySnapshot.docs[0]
        };
    }
    //
    async function permissionCheck() {
        const eventPromise = admin.firestore().collection('events').doc(eventID).get();
        const provokerPromise = admin.firestore().collection('users').doc(provokerUID).get();
        // await promises
        const [eventRef, provokerRef] = await Promise.all([eventPromise, provokerPromise]);
        
        if(!eventRef.exists) {
            throw new functions.https.HttpsError('failed-precondition', 'Event does not exist!');
        }

        const creatorID = eventRef.get('creator_id');
        let authorities = provokerRef.get('authorities'); authorities[provokerUID] = 0;
        
        return Object.keys(authorities).includes(creatorID);
    }
    //
    return Promise.all([permissionCheck(), getUserTicket()]).then(([access, ticket]) => {
        
        if(!access) { // if no access
            throw new functions.https.HttpsError('failed-precondition', 'Permission denied!');
        }

        const ticketExists = ticket.exists;
        const ticketValid = (ticketExists && ticket.ticket.get('status') === 'valid');

        return {'status': 'ok', 'response': {
            'ticket_exists': ticketExists,
            'ticket_valid': ticketValid,
        }}

    });

});

// change user authorities
exports.userChangeAuthorities = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }
    
    let provoker_id = context.auth.uid; // the initiator

    return admin.firestore().collection('users').doc(provoker_id).get().then(user => {
        // get authorities
        let provoker_authorities = user.data()['authorities'];
        // must have maximum authority to perform actions
        if(provoker_authorities[data.authority_id] !== 0) throw new functions.https.HttpsError('failed-precondition', 'Permission denied');
        // update user permissions
        return userUpdatePermissions(data.user_id, data.authority_id, data.level);
    }).then(() => {
        return { "status": "ok" }
    }).catch(error => {
        return error;
    });
});


exports.fetchUserAuthorities = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }

    let provoker_id = context.auth.uid; // the initiator
    
    return admin.firestore().collection('users').doc(provoker_id).get().then(user => {
        // get authorities
        let authorities = user.data()['authorities'];
        // get authorized community keys
        let keys = Object.keys(authorities).filter(key => authorities[key] === 0 && key !== 'self');
        // promise communities
        let requests = keys.map(key => admin.firestore().collection('communities').doc(key).get());
        // add "self" key if it exists
        if(authorities['self'] === 0) { requests.unshift('self') }
        return Promise.all(requests);
    }).then(callback => {
        let response = [];
        callback.forEach(doc => {
            // bool flag if id === 'self'
            let is_self = (doc === 'self');

            if(doc.exists || is_self) {
                response.push({
                    // construct display_name 
                    display_name: (is_self) ? 'Me' : doc.data()['display_name'],
                    // construct aithority image
                    image_id: (is_self) ? "" : (doc.data()['images'][0] || ""),
                    // contruct authority id
                    authority_id: (is_self) ? provoker_id : doc.id
                });
            }
        });
        return { 'status': 'ok', 'response': response }
    }).catch(error => {
        console.log(error);
    });
});

exports.fetchCacheInfo = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }
    // the initiator
    let provoker_id = context.auth.uid;
    //
    let promise_user = admin.firestore().collection('users').doc(provoker_id).get();
    let promise_cache = admin.firestore().collection('metadata').doc('cache').get();

    return Promise.all([promise_user, promise_cache]).then(([user, cache]) => {
        let userCache = user.data()['cache_utc_sec'] || 0;
        let categoriesCache = cache.data()['categories_utc_sec'] || 0;
        let communitiesCache = cache.data()['communities_utc_sec'] || 0;

        let cacheValid = (categoriesCache < userCache && communitiesCache < userCache) ? true : false;
        return { 'status': 'ok', 'response': {'cacheValid': cacheValid }};
    });
});

exports.userSetEmailActive = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }
    
    let provoker_id = context.auth.uid; // the initiator

    return admin.firestore().collection('users').doc(provoker_id).get().then(user => {
        let email_active = user.get('email_active') || false;
        
        if(data.email_active !== undefined) {
            user.ref.update({ email_active: data.email_active });
            email_active = data.email_active;
        }

        return { 'status': 'ok', 'response': {
            'email_active': email_active
        }};
    }).catch(error => {
        return error;
    });
});

exports.fetchUserData = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }

    const userUID = context.auth.uid;
    
    return admin.firestore().collection('users').doc(userUID).get().then(doc => {
        if(!doc.exists) {
            throw new functions.https.HttpsError('failed-precondition', 'User does not exist');
        }

        const userData = doc.data();

        return {'status': 'ok', 'response': {
            'user_rating': userData.user_rating || 0
        }};
    });
});