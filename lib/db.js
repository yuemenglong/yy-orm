var common = require("../../yy-common");
var logger = common.logger;
var ArgPicker = common.ArgPicker;

var Connection = require("./connection");
var Transaction = require("./transaction");
var Model = require("./model");
var kit = require("./kit");
var cond = require("./cond");
var condType = cond.type;
var condTool = cond.tool;

var mysql = require("mysql");
var Promise = require("bluebird");
var util = require("util");

function DB(opt) {
    this.pool = mysql.createPool(opt);
    this.models = {};
}
module.exports = DB;

DB.prototype.getConnection = function() {
    var that = this;
    return new Promise(function(resolve, reject) {
        that.pool.getConnection(function(err, conn) {
            if (err) {
                reject(err);
            } else {
                resolve(new Connection(conn));
            }
        })
    });
}
DB.prototype.close = function() {
    var that = this;
    return new Promise(function(resolve, reject) {
        that.pool.end(function(err) {
            if (err !== undefined) {
                reject(err);
            } else {
                resolve();
            }
        })
    })
}

DB.prototype.define = function(table, def) {
    var ret = new Model(table, def, this);
    this.models[table] = ret;
    return ret;
}

DB.prototype.sync = function() {
    var result = Promise.resolve();
    for (var table in this.models) {
        var model = this.models[table];
        ! function(model) {
            result = result.then(function() {
                return model.sync();
            });
        }(model);
    }
    return result;
}

DB.prototype.drop = function() {
    var result = Promise.resolve();
    for (var table in this.models) {
        var model = this.models[table];
        ! function(model) {
            result = result.then(function() {
                return model.drop();
            });
        }(model);
    }
    return result;
}

DB.prototype.rebuild = function() {
    var that = this;
    return this.drop().then(function() {
        return that.sync();
    })
}

DB.prototype.beginTransaction = function() {
    var that = this;
    return this.getConnection().then(function(conn) {
        tx = new Transaction(conn, that);
        return conn.beginTransaction().then(function(res) {
            return tx;
        });
    });
}

DB.prototype.query = function(query, values, tx) {
    values = values instanceof Transaction ? undefined : values;
    tx = values instanceof Transaction ? values : tx;
    if (tx) {
        return tx.query(query, values);
    }
    return this.getConnection().then(function(conn) {
        return conn.query(query, values).finally(function() {
            conn.release();
        });
    })
}

//string, string/[], cond/object, transaction
DB.prototype.select = function(table, col, c, tx) {
    if (arguments.length !== 4) {
        var args = arguments.$array();
        var picker = new ArgPicker(args);
        tx = picker.rfirst(Transaction);
        c = picker.first([condType.Cond, "object"], 1);
        col = picker.first(["string", "array"], 1);
    }
    if (col === undefined) {
        col = "*";
    } else if (typeof col !== "string") {
        col = mysql.format("??", col);
    }
    c = condTool.parseToCondObj(c);
    var that = this;
    if (c) {
        var condStr = c.toSql();
        var sql = util.format("SELECT %s FROM %s WHERE %s", col, table, condStr);
    } else {
        var sql = util.format("SELECT %s FROM %s", col, table);
    }
    return this.query(sql, tx).then(function(res) {
        return res.rows;
    });
}

//string, string/[], cond/object, transaction
DB.prototype.one = function(table, col, c, tx) {
    if (arguments.length !== 4) {
        var args = arguments.$array();
        args.length = arguments.length;
        var picker = new ArgPicker(args);
        tx = picker.rfirst(Transaction);
        c = picker.first([condType.Cond, "object"], 1);
        col = picker.first(["string", "array"], 1);
    }
    c = condTool.parseToCondObj(c);
    if (c instanceof condType.Limit === false) {
        c = cond.limit(c, 1);
    }
    return this.select(table, col, c, tx).then(function(res) {
        return res[0];
    })
}

DB.prototype.insert = function(table, obj, tx) {
    var that = this;
    return Promise.try(function() {
        if (Array.isArray(obj) && obj.length > 0) {
            var cols = obj[0].$keys();
            var values = [];
            for (var i in obj) {
                values.push(obj[i].$values());
            }
        } else {
            var cols = obj.$keys();
            var values = [obj.$values()];
        }
        var fmt = "INSERT INTO ??(??) VALUES ?";;
        var sql = mysql.format(fmt, [table, cols, values]);
        return that.query(sql, tx);
    }).then(function(res) {
        return res.rows;
    });
}

DB.prototype.create = function(table, obj, tx) {
    var that = this;
    return Promise.try(function() {
        var model = that.models[table];
        if (!model) {
            return obj;
        } else {
            return model.toRow(obj);
        }
    }).then(function(obj) {
        var cols = [];
        var values = [];
        for (var col in obj) {
            if (obj.hasOwnProperty(col)) {
                cols.push(col);
                values.push(kit.normalize(obj[col]));
            }
        }
        var col = cols.join(", ");
        var value = values.join(", ");
        var fmt = "INSERT INTO %s(%s) VALUES(%s)";
        var sql = util.format(fmt, table, col, value);
        return that.query(sql, tx);
    });
}

DB.prototype.update = function(table, obj, c, tx) {
    c = condTool.parseToCondObj(c);
    if (c === undefined) {
        var fmt = "UPDATE ?? SET ?";
        var sql = mysql.format(fmt, [table, obj]);
    } else {
        var fmt = "UPDATE ?? SET ? WHERE " + c.toSql();
        var sql = mysql.format(fmt, [table, obj]);
    }
    return this.query(sql, tx).then(function(res) {
        return res.rows;
    });
}
DB.prototype.delete = function(table, c, tx) {
    c = condTool.parseToCondObj(c);
    var fmt = "DELETE FROM ?? WHERE " + c.toSql();
    var sql = mysql.format(fmt, table);
    return this.query(sql, tx).then(function(res) {
        return res.rows;
    });
}
DB.prototype.count = function(table, c, tx) {
    return this.select(table, "COUNT(1) AS COUNT", c, tx).then(function(res) {
        return res.rows[0]["COUNT"];
    });
}