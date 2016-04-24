var http     = require('http');
var express  = require('express');
var redis    = require('redis');
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
  
  //IMPORTANT: use JWT instead
  try
  {
    signed = JSON.parse(token);
  }
  catch(err)
  {
    console.log('unable to parse token!'); 
    return;
  }

  var redisClient = createRedisClient(), redisClient2 = createRedisClient();

  var tcode = signed.tcode;
  var current_page = 1;
  var current_user_page = 1;
  var num_users = 0;
  var num_onlines = -1;
  var online_list = {};
  var test_content = {};
  var intervalID;

  // redis key names
  var RKEY_CLASSINFO       = 'rb.' + tcode + '.info';
  var RKEY_USERPROFILE     = 'rb.' + tcode + '.profile';
  var RKEY_ONLINES         = 'rb.' + tcode + '.online';
  var RKEY_STATS           = 'rb.' + tcode + '.stats';
  var RKEY_PREFIX_USERPAGE = 'rb.' + tcode + '.users.';
  var RKEY_TMP             = 'rb.' + tcode + '.tmp';
  var RCHANNEL             = 'rb.' + tcode + '.channel';

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
    if(message.page)
      current_page = message.page;
    else if(message.num_users)
      num_users = (message.num_users);
    socket.emit('message', message);
  });

  //0. connect to redis
  redisClient.on('connect', function() {

    //1. get class info
    redisClient.hgetall(RKEY_CLASSINFO, function(err,objInfo) {
      
      try
      {
        if(!objInfo)
          throw 'trec info not exists'

        current_page = (objInfo.page == null) ? 1 : parseInt(objInfo.page);
        num_users = (objInfo.num_users == null) ? 0 : parseInt(objInfo.num_users);
      }
      catch(err)
      {
        socket.emit({'message': 'error'})
        socket.disconnect();
        return;
      }


      // getClassroomStats
      function getClassroomStats(callback) {
        var page = current_page;
        if( test_content[page] != null )
        {         
          var keys = [];
          for(var i=1; i<=test_content[page].opt; i++)
          {
            keys.push(page.toString() + '.' + i.toString());
          }
          if(test_content[page].type == '2') //HACKS
          {
            keys.push(page.toString() + '.R.1');
            keys.push(page.toString() + '.R.2');           
          }

          redisClient2.hmget(RKEY_STATS, keys, function(err,obj) {
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
              }
            }
          });
        }
        intervalID = setInterval(poll, 5000);
      } //end stats   
      
      // numOnlines 
      function getNumOnlines() {
        var timestamp = Math.floor(Date.now() * 0.001) - 60;  // remove users from available list by timestamp

        redisClient2.zremrangebyscore(RKEY_ONLINES, '-inf', '(' + timestamp.toString(), function() {
          
          redisClient2.zcard(RKEY_ONLINES, function(err, obj) {
            var new_num_onlines = parseInt(obj); 

            if( num_onlines != new_num_onlines )
            {
              num_onlines = new_num_onlines;
              console.log('emit:' + num_onlines.toString() );
              socket.emit('message', {num_onlines:num_onlines});  
            }

            var tmp_current_user_page = current_user_page;
            redisClient2.zinterstore(RKEY_TMP, 2, RKEY_ONLINES, RKEY_PREFIX_USERPAGE+tmp_current_user_page.toString(), function(err, obj) {
              redisClient2.zrange(RKEY_TMP, 0, -1, function(err, obj) {

                if(obj.length==0)
                {
                  if(online_list[tmp_current_user_page]!=null)
                  {
                    socket.emit('message', {user_page:tmp_current_user_page, offline_list:online_list[tmp_current_user_page]});  
                    delete online_list[tmp_current_user_page];
                  }  
                }
                else
                {
                  if(online_list[tmp_current_user_page]==null)
                  {
                    online_list[tmp_current_user_page] = {};
                    for(var i in obj)
                      online_list[tmp_current_user_page][obj[i]] = '';   
                  }  
                  else
                  {
                    var offline_list = [];
                    for(var item in online_list[tmp_current_user_page])
                    {
                      var not_found = true;
                      for(var j in obj)
                      {
                        if(item == obj[j])
                        {
                          not_found = false;
                          break;
                        }
                      }
                      if(not_found)
                        offline_list.push(item);  
                    }
                    if(offline_list.length > 0)
                    {
                      socket.emit('message', {user_page:tmp_current_user_page, offline_list:offline_list});  
                    }

                    online_list[tmp_current_user_page] = {};
                    for(var k in obj)
                      online_list[tmp_current_user_page][obj[k]] = '';                 
                  }
                }      
                getClassroomStats();  
              });

            });

          });  
                                    
        });      
      }

      // poll function
      var poll = function() {
        if(!socket.connected)
        {
          clearInterval(intervalID);
          return;
        }
        clearInterval(intervalID);
        getNumOnlines();
      };

      if('test' in objInfo && objInfo.test != 0)
      {        
        redisClient.hgetall('test.' + objInfo.test, function(err,objTest) {
          test_content = JSON.parse(objTest.dc);
          for (var page in test_content)
            test_content[page].stats = new Array(test_content[page].opt || 2).fill(0);                    
          
          intervalID = setInterval(poll, 5000);  

        }); 
      }
      else
      {
        intervalID = setInterval(poll, 5000);        
      }

      redisClient.subscribe('rb.' + tcode + '.channel'); 

    });  

  }); 
  
});  



