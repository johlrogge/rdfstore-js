
// imports
var utils = require('./utils');
var _ = utils;
var async = utils;

/*
 * "perfect" indices for RDF indexing
 *
 * SPOG (?, ?, ?, ?), (s, ?, ?, ?), (s, p, ?, ?), (s, p, o, ?), (s, p, o, g)
 * GP   (?, ?, ?, g), (?, p, ?, g)
 * OGS  (?, ?, o, ?), (?, ?, o, g), (s, ?, o, g)
 * POG  (?, p, ?, ?), (?, p, o, ?), (?, p, o, g)
 * GSP  (s, ?, ?, g), (s, p, ?, g)
 * OS   (s, ?, o, ?)
 *
 * indices for  URI references
 * 
 * subject 
 * predicate
 * object
 * graph
 *
 * @param configuration['dbName'] Name for the IndexedDB
 * @return The newly created backend.
 */
QuadBackend = function (configuration, callback) {
    var that = this;

    if (arguments !== 0) {

        utils.registerIndexedDB(that);

        this.indexMap = {};
        this.indices = ['SPOG', 'GP', 'OGS', 'POG', 'GSP', 'OS'];
        this.componentOrders = {
            SPOG:['subject', 'predicate', 'object', 'graph'],
            GP:['graph', 'predicate', 'subject', 'object'],
            OGS:['object', 'graph', 'subject', 'predicate'],
            POG:['predicate', 'object', 'graph', 'subject'],
            GSP:['graph', 'subject', 'predicate', 'object'],
            OS:['object', 'subject', 'predicate', 'graph']
        };

        that.dbName = configuration['name'] || "rdfstorejs";
        var request = that.indexedDB.open(this.dbName+"_db", 2);
        request.onerror = function(event) {
            callback(null,new Error("Error opening IndexedDB: " + event.target.errorCode));
        };
        request.onsuccess = function(event) {
            that.db = event.target.result;
            callback(that);
        };
        request.onupgradeneeded = function(event) {
            var oldVersion = event.oldVersion || 0;
            var newVersion = event.newVersion || 2;
            
            var db = event.target.result;
            function createGraphIndices(objectStore){
                _.each(that.indices, function(index){
                    if(index !== 'SPOG') {
                        objectStore.createIndex(index,index,{unique: false});
                    }
                });
            };

            function createEntityIndices(objectStore){
                _.each(that.componentOrders['SPOG'], function(index){
                    objectStore.createIndex(index, index, {unique: false});
                })
                    };

            if (oldVersion < 1) {
                var objectStore = db.createObjectStore(that.dbName, { keyPath: 'SPOG'});
                createGraphIndices(objectStore);
                createEntityIndices(objectStore);
            }
            else if(oldVersion < 2) {
                var transaction = event.target.transaction;
                var objectStore = transaction.objectStore(that.dbName);
                createGraphIndices(objectStore);
                createEntityIndices(objectStore);
            }
        };
    }
};


QuadBackend.prototype.index = function (quad, callback) {
    var that = this;
    _.each(this.indices, function(index){
        quad[index] = that._genMinIndexKey(quad, index);
    });

    var transaction = that.db.transaction([that.dbName],"readwrite");
    transaction.oncomplete = function(event) {
        //callback(true)
    };
    transaction.onerror = function(event) {
        callback(null, new Error(event.target.statusCode));
    };
    var objectStore = transaction.objectStore(that.dbName);
    var request = objectStore.add(quad);
    request.onsuccess = function(event) {
        callback(true)
    };
};

QuadBackend.prototype.range = function (pattern, callback) {
    var that = this;
    var objectStore = that.db.transaction([that.dbName]).objectStore(that.dbName);
    var indexKey = this._indexForPattern(pattern);
    var minIndexKeyValue = this._genMinIndexKey(pattern,indexKey);
    var maxIndexKeyValue = this._genMaxIndexKey(pattern,indexKey);
    var keyRange = that.IDBKeyRange.bound(minIndexKeyValue, maxIndexKeyValue, false, false);
    var quads = [];
    var cursorSource;

    if(indexKey === 'SPOG') {
        cursorSource = objectStore;
    } else {
        cursorSource = objectStore.index(indexKey);
    }

    cursorSource.openCursor(keyRange).onsuccess = function(event) {
        var cursor = event.target.result;
        if (cursor) {
            quads.push(cursor.value);
            cursor.continue();
        } else {
            callback(quads);
        }
    }
};

QuadBackend.prototype.search = function (quad, callback) {
    var that = this;
    var objectStore = that.db.transaction([that.dbName]).objectStore(that.dbName);
    var indexKey = this._genMinIndexKey(quad, 'SPOG');
    var request = objectStore.get(indexKey);
    request.onerror = function(event) {
        callback(null, new Error(event.target.statusCode));
    };
    request.onsuccess = function(event) {
        callback(event.target.result != null);
    };
};


QuadBackend.prototype.delete = function (quad, callback) {
    var that = this;
    var indexKey = that._genMinIndexKey(quad, 'SPOG');
    var request = that.db.transaction([that.dbName], "readwrite")
        .objectStore(that.dbName)
        .delete(indexKey);
    request.onsuccess = function() {
        callback(true);
    };
    request.onerror = function(event) {
        callback(null, new Error(event.target.statusCode));
    };
};

QuadBackend.prototype._genMinIndexKey = function(quad,index) {
    var indexComponents = this.componentOrders[index];
    return _.map(indexComponents, function(component){
        if(typeof(quad[component]) === 'string' || quad[component] == null) {
            return "-1";
        } else {
            return ""+quad[component];
        }
    }).join('.');
};

QuadBackend.prototype._genMaxIndexKey = function(quad,index) {
    var indexComponents = this.componentOrders[index];
    var acum = [];
    var foundFirstMissing = false;
    for(var i=0; i<indexComponents.length; i++){
        var component = indexComponents[i];
        var componentValue= quad[component];
        if(typeof(componentValue) === 'string') {
            if (foundFirstMissing === false) {
                    foundFirstMissing = true;
                if (i - 1 >= 0) {
                    acum[i - 1] = acum[i - 1] + 1
                }
            }
            acum[i] = -1;
        } else {
            acum[i] = componentValue;
        }
    }
    return _.map(acum, function(componentValue){
        return ""+componentValue
    }).join('.');
};


QuadBackend.prototype._indexForPattern = function (pattern) {
    var indexKey = pattern.indexKey;

    for (var i = 0; i < this.indices.length; i++) {
        var index = this.indices[i];
        var indexComponents = this.componentOrders[index];
        for (var j = 0; j < indexComponents.length; j++) {
            if (_.include(indexKey, indexComponents[j]) === false) {
                break;
            }
            if (j == indexKey.length - 1) {
                return index;
            }
        }
    }

    return 'SPOG'; // If no other match, we return the more generic index
};


QuadBackend.prototype.clear = function(callback) {
    var that = this;
    var transaction = that.db.transaction([that.dbName],"readwrite"), request;
    request = transaction.objectStore(that.dbName).clear();
    request.onsuccess = function(){ callback(); };
    request.onerror = function(){ callback(); };
};

QuadBackend.prototype.countReferences = function(id, callback) {
    var that = this,
        transaction = that.db.transaction([that.dbName], "readwrite"),
        request;
    var result = [];
    for(key in that.componentOrders.SPOG) {
        (function(){
            var index = that.componentOrders.SPOG[key];
            request = transaction.objectStore(that.dbName).index(index).count(id);
            request.onsuccess = function(event) {
                result.push(event.target.result);
                if(result.length === that.componentOrders.SPOG.length)  {
                    var total = 0;
                    for(i in result) {
                        total = total + result[i];
                    }
                    callback(total);
                }
            };
            request.onerror = function(){
                callback();
            };
        })();
    }
}

QuadBackend.prototype.allCounts = function(callback) {
    var ids = {};
    var transaction = this.db.transaction([this.dbName],'readwrite');
    function countIds(objectStore, idField, cb) {
        var request = objectStore.openCursor();
        function add(acc, triple, key) {
            var id = triple[key];
            var current = acc[id];
            acc[id] = 1+ (current||1);
            return acc;
        };
        request.onsuccess = function(event) {
            var cursor = event.target.result;
            if(cursor) {
                var triple = cursor.value;
                ids = add(ids, triple, 'subject');
                ids = add(ids, triple, 'predicate');
                ids = add(ids, triple, 'object');
                cursor.continue();
            } else {
                cb(ids);
            }
        };
        request.onerror = function(event) {
            cb(null,new Error("Error retrieving data from the cursor: " + event.target.errorCode));
        }
    }

    countIds(transaction.objectStore(this.dbName),'id', callback);
}

module.exports.QuadBackend = QuadBackend;
