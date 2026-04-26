-- =============================================================================
-- V034: notification_channel.channel_type constraint'ine telegram eklendi
--
-- V018 sadece email/slack/pagerduty/teams/webhook'a izin veriyordu.
-- NotificationService telegram destegine sahip, ama DB constraint reddediyordu.
-- =============================================================================

alter table control.notification_channel
  drop constraint if exists notification_channel_channel_type_check;

alter table control.notification_channel
  add constraint notification_channel_channel_type_check
  check (channel_type in ('email', 'slack', 'pagerduty', 'teams', 'webhook', 'telegram'));
