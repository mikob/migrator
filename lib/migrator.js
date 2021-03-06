var _ = require('lodash');
var child_process = require("child_process");
var exec = child_process.exec;
var fs = require("fs");
var util = require('util');


function pad(n, width, z) {
    z = z || '0';
    width = width || 2;
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) +
        n;
}


var dateString = function(date) {
    return "" +
        date.getFullYear() + '-' +
        pad(date.getMonth() + 1) + '-' +
        pad(date.getDate()) + '_' +
        pad(date.getHours()) + '-' +
        pad(date.getMinutes()) + '-' +
        pad(date.getSeconds()) + '-' +
        pad(date.getMilliseconds(), 3);
}


// Creates the scaffolding for a migration
// jsMigration [boolean] true if js, false if sql
function getScaffolding(jsMigration) {
    if (jsMigration) {
        return "module.exports.migrate = function(db, callback) {\n};";
    } else {
        return "";
    }
}


function openInEditor(editor, filePath) {
    var editor = child_process.spawn(editor, [filePath], {
        stdio: 'inherit'
    });
    editor.on('exit', process.exit);
}


// All the ones in the database
function getExecutedMigrations(db) {
    return new Promise(function(resolve, reject) {
        db.query('SELECT "version" FROM "schema_migrations"', function(err, resp) {
            if (err) {
                // if there is an error assume we are at the default state, and run root migration
                // attempt to run file located at appRoot/migrations/schema/root.sql -- good for previous data force load (e.g. Rails)
                let schema = fs.readFileSync(migrationsDir + "schema/root.sql").toString();
                db.query(schema); // populate with root schema if not populated.
                reject(Error(err));
            } else {
                // if no error, dump all versions into an array called executed for quick searching.
                resolve(_.map(resp.rows, 'version'));
            }
        });
    });
}


// All the ones in the filesystem
function getExistingMigrations(migrationsDir) {
    return new Promise(function(resolve, reject) {
        // populate all existing migrations by reading the migrations directory
        fs.readdir(migrationsDir, function(err, list) {
            if (err) {
                reject(Error(err));
            } else {
                let migrations = [];
                let m = undefined;
                let j = undefined;

                for (let li = 0; li < list.length; li++) {
                    if (m = list[li].match(/(.*)\.sql/)) {
                        // if the file has a .sql extension, load it as a file read for sql schema updating
                        try {
                            migrations.push({
                                id: m[1],
                                sql: fs.readFileSync(migrationsDir + m[0]).toString()
                            });
                        } catch (err) {
                            console.error(util.format("Error reading sql migration %s. \n%s", m[0], err));
                        }
                    } else if (j = list[li].match(/(.*)\.js/)) {
                        // if the file has a .js extension, load via require system and set js attribute as .migrate function
                        try {
                            migrations.push({
                                id: j[1],
                                js: require(migrationsDir + "/" + list[li]).migrate
                            });
                        } catch (err) {
                            console.error(util.format("Error reading js migration %s. \n%s", list[li], err));
                        }
                    }
                }

                resolve(migrations);
            }
        });
    });
}


function runMigration(db, openTransaction, closeTransaction, migration) {
    return new Promise(function(resolve, reject) {

        console.log("Executing migration: " + migration.id);

        // check if migration is SQL
        if (migration.sql) {

            // suffix with schema migrations insertion so we dont run again if successful.
            var sql = openTransaction + migration.sql + "; INSERT INTO schema_migrations VALUES ('" +
                migration.id + "'); " + closeTransaction;

            // execute the full query
            db.query(sql, function(e, r) {
                if (e) {
                    db.query("ROLLBACK;", function() {
                        // if error, dump why we couldn't migrate and process no more.
                        reject(util.format("Could not migrate %s. Error: %s", migration.id, e));
                    });
                } else {
                    resolve();
                }
            });

        } else {
            // migration is JS code
            // pass our db object and execute with callback to insert into schema migration AND recurse with rest of "torun" array
            migration.js(db, function() {
                db.query("INSERT INTO schema_migrations VALUES ($1)", [migration.id], function(err, resp) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        }
    });
}


module.exports.migrate = async function(appRoot, appConfig, options) {
    var editor = process.env.EDITOR;
    var db;
    var openTransaction;
    var closeTransaction;
    // set up the migrations directory
    var migrationsDir = appRoot + "migrations/";

    if (options && options.editor) {
        editor = options.editor;
    }

    // determine working condition.
    if (appConfig.postgresql) {
        // load postgresql library
        try {
            var pg = require("pg");
        } catch (e) {
            console.log("You must install pg globally!");
        }

        // create and connect db
        db = new pg.Client(appConfig.postgresql);
        db.connect();
        openTransaction = "BEGIN; ";
        closeTransaction = "COMMIT; ";

    } else if (appConfig.mysql) {
        try {
            var mysql = require("mysql");
        } catch (e) {
            console.log("You must install mysql globally!");
        }

        // create and connect db
        db = mysql.createClient(appConfig.mysql);
        openTransaction = "START TRANSACTION; ";
        closeTransaction = "COMMIT; ";

    } else {
        console.log("You must specify a connection string for either PostgreSQL or MySQL");
        process.exit(-1);
    }


    // if requested with no parameters
    if (process.argv.length <= 2) {
        var executed = await getExecutedMigrations(db);
        var migrations = await getExistingMigrations(migrationsDir);

        var migrationsToRun = _.sortBy(_.filter(migrations,
            function(migration) {
                return !~executed.indexOf(migration.id);
            }), 'id');

        Promise.all(_.map(migrationsToRun, function(mig) {
            return runMigration(db, openTransaction, closeTransaction, mig);
        })).then(function() {
            console.log("Completed successfully");
            db.end();
            process.exit(0);
        }).catch(function(e) {
            console.error(e);
            db.end();
            process.exit(-1);  // get on with your life
        });

    } else {
        if (process.argv[2] == "generate" || process.argv[2] == "-g") {
            // if provided a generate argument: ./script/migrate generate or ./script/migrate -g
            var jsMigration = (process.argv[3] === "js");
            var fileName = dateString(new Date());
            var filePath = util.format("%s%s.%s", migrationsDir, fileName,
                jsMigration ? "js" : "sql");
            var scaffolding = getScaffolding(jsMigration);

            fs.writeFileSync(filePath, scaffolding);
            console.log(util.format("Created new migration file: %s", fileName));
            openInEditor(editor, filePath);
        } else if (process.argv[2] == "--dry-run") {
            var executed = await getExecutedMigrations(db);
            var migrations = await getExistingMigrations(migrationsDir);

            var migrationsToRun = _.sortBy(_.filter(migrations,
                function(migration) {
                    return !~executed.indexOf(migration.id);
                }), 'id');

            if (migrationsToRun.length > 0) {
                console.log("Migrations that would be run: ");
            } else {
                console.log("No migrations haven't been applied.");
            }
            _.map(migrationsToRun, function(mig) {
                console.log(mig.id);
            });
            process.exit(0);
        } else {
            // run a specific migration
            var migrationsToRun = _.map(process.argv.slice(2), function(migration) {
                var parts = migration.split('.');
                var ret = {};
                var fn;

                if (parts[1] == 'sql') {
                    fn = fs.readFileSync(migrationsDir + '/' + migration).toString();
                } else {
                    fn = require(migrationsDir + "/" + migration).migrate;
                }
                ret.id = parts[0];
                ret[parts[1]] = fn;
                return ret;
            });

            Promise.all(_.map(migrationsToRun, function(mig) {
                return runMigration(db, openTransaction, closeTransaction, mig);
            })).then(function() {
                console.log("Completed succesfully.");
                db.end();
                process.exit(0);  // get on with your life
            }).catch(function(e) {
                console.error(e);
                db.end();
                process.exit(-1);  // get on with your life
            });
        }
    }
};
