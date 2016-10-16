var jwt = require('express-jwt');
var Express = require('express');
var Webtask = require('webtask-tools');
var _ = require('lodash');
var request = require('request');
var bodyParser = require('body-parser');
var genfun = require('generate-function');

var app = Express();

app.use(bodyParser.json());

app.use(function getAuth0Config (req, res, done) {
  var secrets = req.webtaskContext.secrets;

  // load auth0 config object with secret values
  req.auth0 = {
    client_id: secrets.client_id,
    client_secret: secrets.client_secret,
    domain: secrets.domain,
    admin_authz: null,
    api_access_token: secrets.api_access_token
  };

  if (secrets.admin_authz) {
    // attempt to parse admin_authz into a function
    try {
      req.auth0.admin_authz = genfun()
        (secrets.admin_authz)
        .toFunction();
    } catch (e) {
      return done(new Error('admin_authz secret could not be parsed into a JavaScript function: ' + e));
    }
  }

  // assert that all values were populated
  var missingKeys = Object.keys(req.auth0).reduce(function (previous, key) {
    var secret = req.auth0[key];
    if (secret === undefined)
      previous.push(key);
    return previous;
  }, []);
  if (missingKeys.length > 0)
    return done(new Error('Missing secrets: ' + missingKeys));

  done();
});

// authenticate
app.use(jwt({
  secret: function(req, payload, done) {
    done(null, new Buffer(req.auth0.client_secret, 'base64'));
  }
}));

// authorize
app.use(function authorize (req, res, done) {
  var issuer = 'https://' + req.auth0.domain + '/';

  if (req.user.iss !== issuer)
    return res.status(401).send('Untrusted issuer');
  if (req.user.aud !== req.auth0.client_id)
    return res.status(401).send('Incorrect audience');

  // admin for all users
  if (req.auth0.admin_authz.length === 1 && !req.auth0.admin_authz(req.user))
    return res.status(401).send('User unauthorized');

  done();
});

// endpoints

function apiReverseProxy (req, res, next) {
  const accountId = req.user.app_metadata.accountId;

  leq qs = _.omit(req.query, 'webtask_no_cache');

  //if read users
  if(req.method === 'GET' && req.path === '/users')
  {
    qs = 'q=app_metadata.accountId="'+ accountId + '"';
  }

  //if write user
  if(req.method === 'GET' && req.path === '/users')
  {
    const valid_domains = req.user.app_metadata.valid_email_domains;
    const new_user_domain = req.body.email.split('@')[1];
    var isValidDomain = false;
    for(var i = 0; i < valid_domains.length; i++)
    {
      if(new_user_domain === valid_domains[i])
      {
        isValidDomain = true;
      }
    }
    req.body.connection = req.user.app_metadata.user_connection;

    req.body.app_metadata = {
      accountId: req.user.app_metadata.accountId,
      accountName: req.user.app_metadata.accountName,
      accountAdmin: false,
      owner:false,
      vendor:false
    }

  }



  var opts = {
    method: req.method,
    uri: 'https://' + req.auth0.domain + '/api/v2' + req.path,
    qs: qs,
    auth: { bearer: req.auth0.api_access_token },
    json: Object.keys(req.body).length > 0 ? req.body : null
  };

  request(opts)
    .on('request', function (request) {
      var loggedRequest = {
        method: request.method,
        path: request.path,
        headers: _.clone(request._headers)
      };
      loggedRequest.headers.authorization = 'Bearer XXX';

      console.log('Auth0 API Call:', {
        by_user: req.user.sub,
        request: loggedRequest
      });
    })
    .on('error', function (err) {
      console.log(err);
    })
    .pipe(res);
}

app.get('/users', apiReverseProxy);
app.post('/users', apiReverseProxy);
app.get('/users/:id', apiReverseProxy);
app.del('/users/:id', apiReverseProxy);
app.patch('/users/:id', apiReverseProxy);

// errors

app.use(function errorHandler (err, req, res, next) {
  if (err.message && err.status && err.status < 500) {
    // client errors
    res.status(err.status).send(err.message);
  } else {
    // server errors
    console.log(err.stack ? err.stack : err);

    res.status(500).send('Something borked!');
  }
});

module.exports = Webtask.fromExpress(app);
