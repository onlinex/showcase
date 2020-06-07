// SDK
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const request =  require('request-promise');
// other
//const functionsHttps = require('../index.js').functionsHttps;
const functionCreate = require('../index.js').functionCreate;

////////////////////////////////////////////////////////
///////////////////* Event creation *///////////////////
////////////////////////////////////////////////////////

//
function initializeEvent(t, userUID, forceUpdateID) {
    // fetch user
    const userDoc = (userUID) ? t.get(admin.firestore().collection('users').doc(userUID)) : null;
    // fetch event if exist
    const eventDoc = (forceUpdateID) ? (
        t.get(admin.firestore().collection('events').doc(forceUpdateID))
    ) : ( 
        new Object({
            exists: false,
            data: () => {
                return {};
            },
            get: () => {
                return undefined
            },
            ref: admin.firestore().collection('events').doc()
        })
    );
    // return user and event
    return Promise.all([userDoc, eventDoc]);
}

//
async function getCreatorData(userUID, authorityID) {
    
    if(!authorityID) {
        return {} // nothing to update
    }

    const userGenerated = (authorityID === 'self') ? true : false;

    const creatorName = userGenerated ? (
        await admin.auth().getUser(userUID).then(userRecord => {
            return userRecord.displayName || "Anonymous";
        })
    ) : (
        await admin.firestore().collection('communities').doc(authorityID).get()
        .then(doc => {
            return doc.get('display_name');
        }).catch(error => {
            throw new functions.https.HttpsError('failed-precondition', 'Organizer not found.');
        })
    );

    const creatorID = userGenerated ? userUID : authorityID;

    return {
        user_generated: userGenerated, creator_name: creatorName, creator_id: creatorID
    };
}

//
function updateOptions(event, params) {
    let updateObject = new Object();
    // mandatory parameters if the event is being created
    if(!event.exists) {
        updateObject = Object.assign(updateObject, {
            title: "", description: "",
            categories: [], private: false,
            images: ['resized-1200_template.jpg'], main_image: "resized-1200_template.jpg",
            link: "", duration: 0,
            country: "russia", city: "moscow",
            attending: 0, max_attendees: -1, sold_out: false,
            time_state: "future", time_valid: true,
            rating: 0, rating_index: 1,
            external_url: "",
        });
    }
    // optional parameters
    if(params.title) updateObject.title = params.title;
    if(params.description) updateObject.description = params.description;
    if(params.categories) updateObject.categories = params.categories;
    if(params.images) {
        if(params.images.length > 5) {
            throw new functions.https.HttpsError('failed-precondition', 'Maximum of five images are allowed per event');
        }
        if(params.images.length > 0) updateObject.images = params.images.map(el => 'resized-1200_' + el);
    }
    if(params.main_image && typeof(params.main_image) === 'string') {
        updateObject.main_image = 'resized-1200_' + params.main_image;
    } else if(params.images && params.images.length > 0 && !event.exists) {
        updateObject.main_image = updateObject.images[0];
    }
    if(params.private) updateObject.private = params.private;
    if(params.country) updateObject.country = params.country.toLowerCase();
    if(params.city) updateObject.city = params.city.toLowerCase();
    if(params.max_attendees) {
        if(params.max_attendees > (event.get('attending') || 0) || params.max_attendees === -1) {
            updateObject.max_attendees = Math.floor(params.max_attendees);
        }
    }
    if(params.external_url) updateObject.external_url = params.external_url;
    return updateObject;
}

//
function getCategories(t, categories) {
    
    if(!categories) {
        return {};
    }

    const refs = categories.map(id => {
        return admin.firestore().collection('categories').doc(id);
    });

    return t.getAll(...refs).then(snapshots => {
        // 
        let names = snapshots.map((doc, i) => {
            return doc.exists ? doc.get('display_name') : categories[i]
        });
        return {
            categories_prefetched: names
        };
    });
}

//
function getLocation(location) {
    if(!location) {
        return {}
    }

    const [lat, lon] = location.map(e => parseFloat(e)); // unpack values as floats
    return {
        location: new admin.firestore.GeoPoint(lat, lon)
    };
}

//
function getDate(event, date, duration) {
    let updateObject = new Object();

    if(duration && duration >= 0) {
        updateObject.duration = duration;
    }

    if(date) {
        const dateArr = Array.isArray(date) ? date : (
            [
                date['year'], date['month'], date['day'], date['hour'], date['minute'], date['second'], date['time_shift']
            ]
        );

        const localDate = new (Function.prototype.bind.apply(Date, [null].concat(dateArr.slice(0, -1))));
        const utcSec = Math.round(localDate.getTime() / 1000 - dateArr[dateArr.length - 1]);
        const dateStr = localDate.getFullYear() + "-" + (localDate.getMonth() + 1) + "-" + localDate.getDate();

        updateObject.date_str = dateStr;
        updateObject.utc_sec_start = utcSec;
        updateObject.date = {
            year: dateArr[0], month: dateArr[1], day: dateArr[2],
            hour: dateArr[3] || 0, minute: dateArr[4] || 0, second: dateArr[5] || 0
        };

        if(updateObject.duration) { // set duration
            updateObject.utc_sec_end = utcSec + duration;
        } else {
            if(event.exists) {
                updateObject.utc_sec_end = utcSec + event.get('duration');
            } else {
                updateObject.utc_sec_end = utcSec;
            }
        }
    } else {
        if(event.exists) {
            if(updateObject.duration) {
                updateObject.utc_sec_end = event.get('utc_sec_start') + updateObject.duration;
            }
        } else {
            throw new functions.https.HttpsError('failed-precondition', 'Date is a mandatory parameter.');
        }
    }

    return updateObject;
}

//
async function constructTickets(event, updateObject, tickets) {
    
    if(!event.exists) {
        const newDoc = event.ref.collection('eventTickets').doc();

        const eventID = event.ref.id;
        const ticketID = newDoc.id;

        const defaultTicket = {
            max_attendees: updateObject.max_attendees || -1,
            type: 'default',
            attendees_n: 0,
            event_id: eventID,
            ticket_id: ticketID,
            link: await generateTicketLink(ticketID)
        };

        await newDoc.set(defaultTicket);
        return {
            default_ticket: newDoc.id
        };
    } else {
        const defaultTicket = event.get('default_ticket');
        await event.ref.collection('eventTickets').doc(defaultTicket).update({
            max_attendees: updateObject.max_attendees || event.get('max_attendees') || -1
        });
        return {};
    }
}

//
async function publishEvent(t, event, updateObject) {
    
    const title = updateObject.title || event.get('title') || "";
    const description = updateObject.description || event.get('description') || "";
    // generate link
    const shortLink = await generateLink(event.ref.id, title, description);
    // set link
    updateObject.link = shortLink;
    
    if(event.exists) {
        t.update(event.ref, updateObject);
    } else {
        t.set(event.ref, updateObject);
    }
    return Promise.resolve({
        "link": shortLink,
        "id": event.ref.id
    });
}

//
exports.createEvent = functionCreate.https.onCall((data, context) => {
    if(!context.auth && data.claim !== '0x49') {
        throw new functions.https.HttpsError('permission-denied', 'The function must be called ' +
            'while authenticated.'); // code, message
    }

    const userUID = (data.claim !== '0x49') ? context.auth.uid : null; // set provoker id
    const forceUpdateID = (typeof(data.forceUpdateID) === 'string' && data.forceUpdateID.length > 0) ? data.force_update_id : null;

    return admin.firestore().runTransaction(async t => {
        const [user, event] = await initializeEvent(t, userUID, forceUpdateID);
        // check
        if(forceUpdateID && !event.exists) {
            throw new functions.https.HttpsError('failed-precondition', 'Event fetched by forceUpdateID does not exist.');
        }

        const authorities = (user) ? user.get('authorities') : {};
        const authorityID = (data.authority_id !== userUID) ? data.authority_id : 'self'; // set to 'self' if ID is userUID

        if(forceUpdateID) {
            if(authorities[event.get('creator_id')] !== 0 && data.claim !== '0x49') {
                throw new functions.https.HttpsError('permission-denied', 'User does not have the permission for the event.')
            }
        } else {
            if(authorityID === undefined) {
                throw new functions.https.HttpsError('failed-precondition', 'Authority ID is not set.')
            }
            if(authorities[authorityID] !== 0 && data.claim !== '0x49') {
                throw new functions.https.HttpsError('permission-denied', 'User does not have the permissions requested.')
            }
        }

        let updateObject = new Object();

        const [one, two, three, four, five] = await Promise.all([getCreatorData(userUID, authorityID), updateOptions(event, data), getCategories(t, data.categories),
            getLocation(data.location), getDate(event, data.date, data.duration)]);

        updateObject = Object.assign(updateObject, one);
        updateObject = Object.assign(updateObject, two);
        updateObject = Object.assign(updateObject, three);
        updateObject = Object.assign(updateObject, four);
        updateObject = Object.assign(updateObject, five);

        let defaultTicket = await constructTickets(event, updateObject, data.tickets);
        updateObject = Object.assign(updateObject, defaultTicket);

        return publishEvent(t, event, updateObject);
    }).then(c => {
        return {'status': 'ok', 'response': {
            "link": c['link'],
            "id": c['id']
        }};
    }).catch(error => {
        console.log(error);
        throw error;
    });
});


////////////////////////////////////////////////////////
///////////////////* Event deletion *///////////////////
////////////////////////////////////////////////////////

// delete event
exports.deleteEvent = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }
    // the initiator
    let provoker_id = context.auth.uid;
    // generate promises for user and event
    let promise_event = admin.firestore().collection('events').doc(data.event_id).get();
    let promise_user = admin.firestore().collection('users').doc(provoker_id).get();

    return Promise.all([promise_event, promise_user]).then(([eventSnapshot, userSnapshot]) => {
        let provoker_authorities = userSnapshot.data()['authorities'];
        let event_creator_id = eventSnapshot.data()['creator_id'];
        let event_user_generated = eventSnapshot.data()['user_generated'];
        
        // if it is user generated and belong to the user || if user has the higherst authority for the event 
        if((event_user_generated && event_creator_id === provoker_id)
        || (provoker_authorities[event_creator_id] === 0)) {
            return admin.firestore().collection('events').doc(data.event_id).delete(); // delete the document
        } else {
            throw new functions.https.HttpsError('failed-precondition', 'Permission denied');
        }
    }).then(() => {
        return { 'status': 'ok' }
    }).catch(error => {
        console.log(error);
        return error;
    });
});

function deleteImages(images) {
    const bucketName = '*******';
    images.forEach(el => {
        if(!el.includes('template')) {
            admin.storage().bucket(bucketName).file('external/images/' + el).delete()
            .catch(error => { 
                console.log(error);
            });
        }
    })
}

// trigger event deleted
exports.eventDeleteTrigger = functionCreate.firestore.document('events/{eventID}').onDelete((snap, context) => {
    console.log("Event deleted!");
    // remove all event attendees
    return admin.firestore().collection('users').where("attending", "array-contains", snap.id).get().then(snapshots => {
        snapshots.forEach(doc => {
            doc.ref.update({ attending: admin.firestore.FieldValue.arrayRemove(context.params.eventID)});
        });
        return admin.firestore().collection('events').doc(context.params.eventID).collection('eventTickets').get();
    }).then(querySnapshot => {
        querySnapshot.docs.forEach(doc => {
            doc.ref.delete();
        });
        deleteImages(snap.get('images'));

        return Promise.resolve();
    }).catch(error => {
        console.log(error);
        return error;
    });
});

// trigger event updated
exports.eventUpdateTrigger = functionCreate.firestore.document('events/{eventID}').onUpdate((snap, context) => {
    console.log("Event updated!");

    if(snap.after.get('time_state') === 'past') {
        // remove all event attendees
        return admin.firestore().collection('users').where("attending", "array-contains", snap.after.id).get().then(snapshots => {
            snapshots.forEach(doc => {
                // unattend the event
                doc.ref.update({ attending: admin.firestore.FieldValue.arrayRemove(context.params.eventID)});
            });
            // move ticket to the past
            return admin.firestore().collectionGroup('userTickets').where('event_id', '==', context.params.eventID).get();
        }).then(querySnapshot => {
            querySnapshot.forEach(ticket => {
                ticket.ref.update({ status: 'invalid'})
            });
            return Promise.resolve();
        });
    }
    return Promise.resolve();
});

/////////////////////////////////////////////////////////
///////////////////* Fetch attendees *///////////////////
/////////////////////////////////////////////////////////

exports.fetchEventsByAuthority = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }
    // get authority id (user_id or community_id)
    let authority = data.authority_id;

    let promise = admin.firestore().collection('events').where('creator_id', '==', authority).get();
    return promise.then(querySnapshot => {
        let callback = querySnapshot.docs.map(event => {
            if(event.exists) {
                return {
                    'title': event.data()['title'],
                    'id': event.id
                };   
            } else {
                return undefined;
            }
        }).filter(obj => obj !== undefined);
        return { 'status': 'ok', 'response': {
            'events': callback
        }};
    })
});

exports.fetchEventAttendees = functionCreate.https.onCall((data, context) => {
    if(!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.'); // code, message
    }

    let provoker_id = context.auth.uid; // the initiator
    let eventID = data.event_id;

    let promise_provoker = admin.firestore().collection('users').doc(provoker_id).get();
    let promise_event = admin.firestore().collection('events').doc(eventID).get();

    return Promise.all([promise_provoker, promise_event]).then(([provoker, event]) => {
        let creator_id = event.data()['creator_id'];
        
        let authorities = provoker.data()['authorities']; authorities[provoker_id] = 0;
        if(!Object.keys(authorities).includes(creator_id)) {
            return Promise.reject(new functions.https.HttpsError('failed-precondition', 'Permission denied'));
        }

        return admin.firestore().collection('users').select().where('attending', 'array-contains', eventID).get();
    }).then(querySnapshot => {
        return Promise.all(querySnapshot.docs.map(user => admin.auth().getUser(user.id)));
    }).then(userRecords => {
        let users = userRecords.map(user => {
            return {
                'display_name': user.displayName || "Anonymous",
                'email': user.email
            }
        });
        return { 'status': 'ok', 'response': {
            'list': users
        }}
    });
});

////////////////////////////////////////////////////////////
///////////////////* Other constructors *///////////////////
////////////////////////////////////////////////////////////


function generateLink(event_id, title = "HSE connect", description = "") {

    let descriptionShort = (description.length > 32) ? description.substring(0, 32) + '...' : description;

    const api_key = '*******';;

    let options = {
        method: 'POST',
        uri: 'https://firebasedynamiclinks.googleapis.com/v1/shortLinks?key=' + api_key,
        body: {
            "dynamicLinkInfo": {
                "domainUriPrefix": "https://hseconnectservice.page.link",
                "link": "https://hseconnect.ru/?openevent_id=" + event_id.toString(),
                "iosInfo": {
                    "iosBundleId": "*******",
                    "iosAppStoreId": "*******"
                },
                "navigationInfo": {
                    "enableForcedRedirect": true,
                },
                "socialMetaTagInfo": {
                    "socialTitle": title,
                    "socialDescription": descriptionShort
                }
            }
        },
        json: true
    }

    return request(options).then(parsedBody => {
        return parsedBody.shortLink;
    });
}


function generateTicketLink(ticket_id) {
    const api_key = '*******';

    let options = {
        method: 'POST',
        uri: 'https://firebasedynamiclinks.googleapis.com/v1/shortLinks?key=' + api_key,
        body: {
            "dynamicLinkInfo": {
                "domainUriPrefix": "https://hseconnectservice.page.link",
                "link": "https://hseconnect.ru/?verifyticket_id=" + ticket_id.toString()
            }
        },
        json: true
    }

    return request(options).then(parsedBody => {
        return parsedBody.shortLink;
    });
}

// doc_id, creator, title, description, date, duration, location, attending, rating, link
exports.extractDocumentClientFields = function(doc, user_attending_value = false, user_curating_value = false) {
    // get document values
    let data = doc.data();
    // construct return object
    let eventObject = {
        //
        doc_id: doc.id, creator: data['creator_name'],
        title: data['title'], description: data['description'], 
        images: data['images'], main_image: data['main_image'],
        //
        date: data['date'], categories: data['categories_prefetched'],
        categories_ids: data['categories'],
        duration: data['duration'], location: data['location'],
        user_attending: user_attending_value, user_curating: user_curating_value,
        //
        attending: data['attending'], link: data['link'], rating: data['rating'],
        max_attendees: data['max_attendees'], private: data['private'],
        sold_out: data['sold_out'] || false, time_valid: data['time_valid'] || false,
        external_url: data['external_url'] || ""
    }
    return eventObject;
}

