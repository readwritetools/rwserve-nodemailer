//=============================================================================
//
// File:         rwserve-nodemailer/src/index.js
// Language:     ECMAScript 2015
// Copyright:    Read Write Tools © 2018
// License:      MIT License
// Initial date: Sep 3, 2018
//
// Contents:     An RWSERVE plugin to send mail with a fixed message to a given email recipient
// Usage:        Incoming request should be in content-type: 'application/x-www-form-urlencoded'
//               Incoming payload should have one key-value pair: recipient=customer@other-example.com
//               Response will be 400 BAD REQUEST when request is not in the correct format
//               Response will be 200 OK when email was properly prepared and sent to SMTP
//                 Response payload uses content-type 'application/json'
//                 Response payload contains:
//                    "accepted"                 // an array of addresses that were accepted by SMTP
//                    "rejected"                 // an array of addresses that were rejected by SMTP
//                    "response"                 // the last communication from the SMTP server with reply code
//                    "messageId"                // a unique email identifier generated by SMTP for logging
//               Response header 'nodemailer-smtp-reply' is '250' when email was successfully queued for delivery
//
//======================== Sample configuration ===============================
/*
	plugins {
		rwserve-nodemailer {
			location `/srv/rwserve-plugins/node_modules/rwserve-nodemailer/dist/index.js
			config {
				transport {
					host 	    127.0.0.1    // SMTP server address
					port   	    25           // SMTP port: 25, 465, 587
					authMethod	PLAIN
					authUser                 // omit entirely when not needed
					authPassword             // omit entirely when not needed
					connectionTimeout 2000   // 2 seconds, suitable for SMTP running on localhost
				}
				message-defaults {
					from    welcome.team@example.com
					to
					subject Welcome
					text    Thank you for signing up today.%0D%0AThis message confirms your request to join our mailing list.%0D%0ATogether we can make it happen!
				}
			}
		}
		router {
			`/customer-service/signup`  *methods=POST  *plugin=rwserve-nodemailer
		}
	}
*/
//====================== Sample CURL for testing  =============================
//
// curl https://localhost:7443/customer-service/signup -X POST -H content-type:application/x-www-form-urlencoded -H content-length:33 -d "recipient=friendly@mailinator.com"
//
//=============================================================================

var log = require('rwserve-plugin-sdk').log;
var SC = require('rwserve-plugin-sdk').SC;
var nodemailer = require('nodemailer');

module.exports = class RwserveNodemailer {

	constructor(hostConfig) {
		this.hostConfig             = hostConfig;
		this.nodemailerConfig 		= hostConfig.pluginsConfig.rwserveNodemailer;
		this.transportConfig 		= this.nodemailerConfig.transport 		|| {};
		this.messageDefaultsConfig 	= this.nodemailerConfig.messageDefaults || {};
		this.transport = null;
		
    	Object.seal(this);
	}
	
	async startup() {
		log.debug('RwserveNodemailer', 'v1.0.0; © 2018 Read Write Tools; MIT License'); 
		
		var transportOptions = {	
				host: 				this.transportConfig.host 				|| 'localhost',
				port: 				this.transportConfig.port 				|| '25',
				authMethod: 		this.transportConfig.authMethod	 		|| 'PLAIN',
				connectionTimeout: 	this.transportConfig.connectionTimeout	|| '2000'		// two seconds
		};
		// only include auth in options, when needed
		if (this.transportConfig.authUser && this.transportConfig.authPassword) {
			transportOptions.auth = {};
			transportOptions.auth.user = this.transportConfig.authUser;
			transportOptions.auth.pass = this.transportConfig.authPassword;
		}
		var defaultMailOptions = {
	        from: 		this.messageDefaultsConfig.from 	|| '',
	        to: 		this.messageDefaultsConfig.to	 	|| '',
	        subject: 	this.messageDefaultsConfig.subject	|| '',
	        text: 		this.messageDefaultsConfig.text		|| ''
	    };

		try {
			this.transport = nodemailer.createTransport(transportOptions, defaultMailOptions);
		}
		catch (err) {
			log.error(`Unable to create nodemailer transport ${err.message}`);
		}

	}
	
	async shutdown() {
		log.debug('RwserveNodemailer', `Shutting down ${this.hostConfig.hostname}`);
		try {
			this.transport.close();
		}
		catch (err) {
			log.error(err.message);
		}
	}
	
	async processingSequence(workOrder) {
		try {
			if (workOrder.getMethod() != 'POST')
				return;
			
			// validate headers and payload
			var contentType = workOrder.requestHeaders['content-type'];
			if (workOrder.requestHeaders['content-type'] != 'application/x-www-form-urlencoded')
				throw new Error(`content-type header should be application/x-www-form-urlencoded but was ${contentType}`);
				
			var formData = workOrder.incomingPayload;
			if (formData == '')
				throw new Error(`empty payload`);

			var kvpairs = new Map();
			var parts = formData.split('&');
			for (let i=0; i < parts.length; i++) {
				var [key, value] = parts[i].split('=');
				kvpairs.set(key, decodeURIComponent(value));
			}
			if (!kvpairs.has('recipient'))
				throw new Error(`Payload missing 'recipient'`);

			// prepare and send mail to specified recipient
			var mailOptions = {
				// Note: 'from', 'subject', 'text' come from the configuration setting
		        to: kvpairs.get('recipient')
		    };
			var smtpJSON = await this.transport.sendMail(mailOptions);
			
			// HTTP response code is 200; SMTP reply code is in "nodemailer-smtp-reply"; details are in the response body
			var smtpReplyCode = smtpJSON.response.substr(0,3);
			var smtpString = JSON.stringify(smtpJSON, null, 4);
			workOrder.setOutgoingPayload(smtpString);
			workOrder.addStdHeader('content-type', 'application/json');
			workOrder.addStdHeader('nodemailer-smtp-reply', smtpReplyCode);
			workOrder.setStatusCode(SC.OK_200);
			workOrder.noFurtherProcessing();
		}
		catch (err) {
			workOrder.addXHeader('rw-nodemailer', 'failed', err.message, SC.BAD_REQUEST_400);
			workOrder.setEmptyPayload();
		}
	}
}
