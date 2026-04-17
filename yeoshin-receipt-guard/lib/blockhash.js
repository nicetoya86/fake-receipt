/**
 * blockhash.js - Perceptual image hashing (block hash algorithm)
 * Standalone browser implementation, no dependencies required.
 */
(function (global) {
  'use strict';

  function median(data) {
    var sorted = data.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function blockhash(imageData, bits) {
    bits = bits || 16;
    var width = imageData.width;
    var height = imageData.height;
    var data = imageData.data;

    var blockWidth = width / bits;
    var blockHeight = height / bits;
    var blocks = [];

    for (var y = 0; y < bits; y++) {
      for (var x = 0; x < bits; x++) {
        var sum = 0;
        var count = 0;
        for (var by = 0; by < blockHeight; by++) {
          for (var bx = 0; bx < blockWidth; bx++) {
            var px = Math.floor(x * blockWidth + bx);
            var py = Math.floor(y * blockHeight + by);
            var idx = (py * width + px) * 4;
            var r = data[idx];
            var g = data[idx + 1];
            var b = data[idx + 2];
            // Luminance
            sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
            count++;
          }
        }
        blocks.push(sum / count);
      }
    }

    var med = median(blocks);
    var hash = '';
    for (var i = 0; i < blocks.length; i++) {
      hash += blocks[i] >= med ? '1' : '0';
    }
    return hash;
  }

  function hammingDistance(hash1, hash2) {
    if (hash1.length !== hash2.length) return -1;
    var dist = 0;
    for (var i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) dist++;
    }
    return dist;
  }

  function blockhashFromImage(img, bits) {
    bits = bits || 16;
    var canvas = document.createElement('canvas');
    canvas.width = bits * 4;
    canvas.height = bits * 4;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return blockhash(imageData, bits);
  }

  global.blockhash = {
    hash: blockhashFromImage,
    hammingDistance: hammingDistance
  };

})(typeof window !== 'undefined' ? window : this);
