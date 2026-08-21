-- Emergency rollback for the distributed runtime schema.
-- Disable NUVILOVIEW_DISTRIBUTED_SINGLETON on every host and stop the external
-- monitor before running this file. Existing analytics and bot_heartbeat data
-- are not touched.
DROP TABLE IF EXISTS "service_heartbeat";
DROP TABLE IF EXISTS "service_lease";
