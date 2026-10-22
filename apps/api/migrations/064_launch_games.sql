-- Which games can be listed (Designer's "needs back-end": the app limits the sell form to the launch
-- games; the API must refuse the rest too). NULL opens every game; staff edit the list from the
-- launch settings as game votes bring new games in.
ALTER TABLE launch_settings ADD COLUMN allowed_games text[] DEFAULT ARRAY['Aion', 'Aion 2', 'Albion Online', 'Path of Exile', 'Path of Exile 2'];

CREATE OR REPLACE FUNCTION game_allowed(game text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN (SELECT allowed_games FROM launch_settings) IS NULL THEN true
              ELSE lower($1) = ANY (SELECT lower(unnest(allowed_games)) FROM launch_settings) END
$$;
