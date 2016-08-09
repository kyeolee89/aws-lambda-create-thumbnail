// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm').subClass({ imageMagick: true }); // Enable ImageMagick integration.
var util = require('util');
var https = require('https');

// get S3 client
var s3 = new AWS.S3();
exports.handler = function(event, context) {
	// Read options from the event.
	console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
	// event bucket name
	var srcBucket = event.Records[0].s3.bucket.name;
	// save bucket name
	var dstBucket = srcBucket;
	// Object key may have spaces or unicode non-ASCII characters.
	var srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
	var fileName = srcKey.substr(srcKey.lastIndexOf('/')+1);
	// save path
	var dstKey = '';
	var dstKeyPrefix = srcKey.substr(0, srcKey.lastIndexOf('/')+1);
	// 저장되는 파일명에 image_ 형태로 content_type이 포함
	var contentType = srcKey.substring(srcKey.length-2, srcKey.indexOf('image_')).replace('_', '/');
	var imageType = contentType.split('/')[1];

	/* 이미지 비율 정의 배열 */
	var resizeType = ['400', '1024'];

	/* bmp 파일 처리 (image/x-ms-bmp 같은 contentType이 들어오는 경우가 있음) */
	if(contentType.indexOf('bmp') > -1) {
		contentType = 'image/bmp';
		imageType = 'bmp';
	} else if(contentType.indexOf('png') > -1) {
		contentType = 'image/png';
		imageType = 'png';
	}

	/* 이미지 변환 실패시 slack Message 전송을 위한 함수 (lambda computing 40초 기준으로 처리) */
	var slackPush = setTimeout(function(){
		var d = new Date();
		var req = https.request({
			path: '/api/chat.postMessage?token=token&channel=channel&text='+srcBucket + '/' + srcKey+'-H'+d.getHours()+'/M'+d.getMinutes()+'/S'+d.getSeconds()+'&pretty=1',
			method: 'GET',
			host: 'slack.com'
		}, function(res) {

		});

		req.end();
	}, 39000);

	/* 파일 정보 출력 */
	console.log('-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*');
	console.log('fileName : ' + fileName);
	console.log('contentType : ' + contentType);
	console.log('-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*');

	/* email 파일 썸네일의 경우 400사이즈만 생성 */
	if(srcBucket.indexOf('email') > -1) {
		resizeType = ['400'];
	}

	async.forEachOfLimit(resizeType, 1, function(size, index, cb) {

		dstKey = dstKeyPrefix + fileName + '_' + resizeType[index];
		var resizeRatio = resizeType[index];

		async.waterfall([
			function download(next) {
				// Download the image from S3 into a buffer.
				s3.getObject({
						Bucket: srcBucket,
						Key: srcKey
					},
					next);
			},
			function transform(response, next) {
				gm(response.Body).size(function(err, size) {
					// Infer the scaling factor to avoid stretching the image unnaturally.
					var width = resizeRatio;
					var height = resizeRatio * size.height / size.width;
					// Transform the image buffer in memory.

					if(width > size.width) {
						/* 원본 사이즈가 작은 경우 */
						width = size.width;
						height = size.height;
					}

					console.log('width : ' + width);
					console.log('height : ' + height);

					this.resize(width, height)
						.toBuffer(imageType, function(err, buffer) {
							if (err) {
								next(err);
							} else {
								next(null, response.ContentType, buffer);
							}
						});
				});
			},
			function upload(contentType, data, next) {
				// Stream the transformed image to a different S3 bucket.
				s3.putObject({
						Bucket: dstBucket,
						Key: dstKey,
						Body: data,
						ContentType: contentType
					},
					next);
			}
		], function (err) {
			if (err) {
				var errorMsg = 'Unable to resize ' + srcBucket + '/' + srcKey +
						' and upload to ' + dstBucket + '/' + dstKey +
						' due to an error: ' + err;

				console.error(errorMsg);

				var d = new Date();
				var req = https.request({
					path: '/api/chat.postMessage?token=xoxp-2151773333-11273842848-30476966578-de4d1cfaed&channel=%23image_resize_fail&text='+errorMsg+'-H'+d.getHours()+'/M'+d.getMinutes()+'/S'+d.getSeconds()+'&pretty=1',
					method: 'GET',
					host: 'slack.com'
				}, function(res) {

				});

				req.end();
			} else {
				console.log(
					'Successfully resized ' + srcBucket + '/' + srcKey +
					' and uploaded to ' + dstBucket + '/' + dstKey
				);
			}

			console.log(index + ": done")
			cb()

			//context.done();
		});
	}, function() {
		clearTimeout(slackPush);
		console.log('ALL done')
	})
};