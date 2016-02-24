var http     = require('http');
var express  = require('express');
var redis    = require("redis");
var socketIO = require('socket.io');

var app = module.exports.app = express();
var server = http.createServer(app);
var io = socketIO.listen(server); 
server.listen(5002);

app.get('/', function (req, res) {
  res.send('it works');
});

var createRedisClient = function() {
  var host_name = '127.0.0.1';
  var client = redis.createClient(6379, host_name);
  client.on("error", function (err) {
    console.log("[FATAL]redisClient:" + err);
    client = null; 
  }); 
  return client; 
};


var notification = io.of('/notification');
notification.on('connection', function(socket) {
  
  var token = socket.handshake.query.token;
  var socket_id = socket.id;
  var signed;
  
  try
  {
    signed = JSON.parse(token);
  }
  catch(err)
  {
  	console.log('unable to parse token!'); 
    return;
  }

  var redisClient = createRedisClient(), redisClient2;

  var tcode = signed.tcode;
  var current_page = 1;
  var num_users = 0;
  var test_content;
  var intervalID;


  socket.on('disconnect', function(socket) {
    if(intervalID)
      clearInterval(intervalID);    
    if(redisClient) 
      redisClient.end(true);
    if(redisClient2) 
      redisClient2.end(true);
    console.log('disconnect');
  });

  notification.on('disconnect', function(socket){
    if(intervalID)
      clearInterval(intervalID);    
    if(redisClient) 
      redisClient.end(true);
    if(redisClient2) 
      redisClient2.end(true);
    console.log('disconnect');
  });


  redisClient.on("message", function (channel, message) {
    var message = JSON.parse(message);
    console.log('event');
    if(message.page)
      current_page = message.page;
    else if(message.num_users)
      num_users = (message.num_users);
    socket.emit('message', message);
  });


  redisClient.on('connect', function() {
    
    redisClient.hgetall('rb.' + tcode + '.info', function(err,obj) {
      
      current_page = (!obj.page) ? 1 : parseInt(obj.page);
      num_users = (!obj.num_users) ? 0 : parseInt(obj.num_users);

      // check if test content exists 
      if( obj.test && obj.test != "0" )
      {
        redisClient.hgetall('test.' + obj.test, function(err,obj) {
          
          test_content = JSON.parse(obj.dc);
          for (var page in test_content)
            test_content[page].stats =new Array(test_content[page].opt || 2).fill(0);

          var refreshStats = function() {
            if(!socket.connected)
            {
              clearInterval(intervalID);
              return;
            }
            var page = current_page;
            if( test_content[page] != null )
            { 
              clearInterval(intervalID);            
              var keys = [];
              for(var i=1; i<=test_content[page].stats.length; i++)
              {
                keys.push( page.toString() + '.' + i.toString() );
              }

              if(!redisClient2)
              {
                redisClient2 = createRedisClient();    
                redisClient2.on('connect', function(){

                  redisClient2.hmget('rb.' + tcode + '.stats',keys, function(err,obj) {
                    if(page == current_page)
                    { 
                      var update = false;
                      for(var i in obj)
                      { 
                        if(obj[i] && test_content[page].stats[i] != parseInt(obj[i]))
                        {
                          update = true;
                          test_content[page].stats[i] = parseInt(obj[i]);
                        }
                      }
                      if(update)
                      {
                        socket.emit('stats', {page: page, stats: test_content[page].stats});
                        console.log('emit');
                      }
                    }
                    intervalID = setInterval(refreshStats, 5000);
                  });  

                });
              }
              else
              {
                  // redundant
                  redisClient2.hmget('rb.' + tcode + '.stats',keys, function(err,obj) {
                    if(page == current_page)
                    { 
                      var update = false;
                      for(var i in obj)
                      { 
                        if(obj[i] && test_content[page].stats[i] != parseInt(obj[i]))
                        {
                          update = true;
                          test_content[page].stats[i] = parseInt(obj[i]);
                        }
                      }
                      if(update)
                      {
                        socket.emit('stats', {page: page, stats: test_content[page].stats});
                        console.log('emit');
                      }
                    }
                    intervalID = setInterval(refreshStats, 5000);
                  });    
                  // end redundant                               
              }
            }  
          };    
          intervalID = setInterval(refreshStats, 5000);

          redisClient.subscribe('rb.' + tcode + '.channel'); 
        });
      }
      else  // no test content
        redisClient.subscribe('rb.' + tcode + '.channel');
    });    
    
  });
  
});