(* DO NOT EDIT, file generated automatically by scripts/make_tph.ml from src/tph/* *)
let builtin_inlined_files = [(".../WEIDU_NAMESPACE/add_spell.tpa","<<<<<<<< .../inlined/null.file
>>>>>>>>

DEFINE_ACTION_FUNCTION ~TB#ADD_SPELL_GET_CODE~
  INT_VAR tb#scode = 0
  RET tb#filecode
BEGIN
  OUTER_SET tb#type = tb#scode / 1000
  OUTER_SET tb#rest = tb#scode - tb#type * 1000
  ACTION_IF (tb#type == 1) BEGIN
    OUTER_TEXT_SPRINT tb#memo ~pr~
  END
  ELSE ACTION_IF (tb#type == 2) BEGIN
    OUTER_TEXT_SPRINT tb#memo ~wi~
  END
  ELSE ACTION_IF (tb#type == 3) BEGIN
    OUTER_TEXT_SPRINT tb#memo ~in~
  END
  ELSE ACTION_IF (tb#type == 4) BEGIN
    OUTER_TEXT_SPRINT tb#memo ~cl~
  END ELSE BEGIN
    FAIL ~TB#ADD_SPELL_GET_CODE internal failure: invalid code (%tb#scode%)~
  END

  ACTION_IF tb#rest < 10 BEGIN
    OUTER_SPRINT tb#filecode ~%tb#memo%00%tb#rest%~
  END ELSE ACTION_IF tb#rest < 100 BEGIN
    OUTER_SPRINT tb#filecode ~%tb#memo%0%tb#rest%~
  END ELSE BEGIN
    OUTER_SPRINT tb#filecode ~%tb#memo%%tb#rest%~
  END
END

DEFINE_ACTION_FUNCTION ~TB#ADD_SPELL_CHECK_MATCH~
  INT_VAR tb#scode = 0
  RET tb#doesmatch
BEGIN
  ACTION_IF tb#scode < 1000 || tb#scode >= 5000 BEGIN
    OUTER_SET tb#doesmatch = 0
  END ELSE BEGIN
    OUTER_SET tb#newtype  = tb#scode / 1000
    OUTER_SET tb#newlevel = tb#scode / 100 - tb#newtype * 10
    OUTER_SET tb#doesmatch = tb#newtype = tb#type && tb#newlevel = tb#level
  END
END

DEFINE_ACTION_FUNCTION ~TB#ADD_SPELL_FIND_SLOT~
  RET tb#code
BEGIN
  OUTER_PATCH ~~ BEGIN
    SET tb#max_spell = 0
    PATCH_IF (tb#type == 1) BEGIN
      TEXT_SPRINT tb#memo ~pr~
      SET tb#max_spell = 50
    END
    ELSE PATCH_IF (tb#type == 2) BEGIN
      TEXT_SPRINT tb#memo ~wi~
      SET tb#max_spell = 50
    END
    ELSE PATCH_IF (tb#type == 3) BEGIN
      TEXT_SPRINT tb#memo ~in~
      SET tb#max_spell = 99
    END
    ELSE PATCH_IF (tb#type == 4) BEGIN
      TEXT_SPRINT tb#memo ~cl~
      SET tb#max_spell = 99
    END
    SET tb#found_slot = 0
    FOR (tb#num = 1; tb#num <= tb#max_spell && !tb#found_slot; tb#num += 1) BEGIN
      PATCH_IF (tb#num < 10) BEGIN
        TEXT_SPRINT tb#num ~0%tb#num%~
      END
      TEXT_SPRINT tb#code ~%tb#type%%tb#level%%tb#num%~
      LOOKUP_IDS_SYMBOL_OF_INT tb#cur_id ~spell~ tb#code
      PATCH_IF (~%tb#cur_id%~ STRING_EQUAL ~%tb#code%~) BEGIN // slot free in spell.ids
        TEXT_SPRINT tb#cur_id ~%tb#code%~
        PATCH_IF (FILE_EXISTS_IN_GAME ~add_spell.ids~) BEGIN
          LOOKUP_IDS_SYMBOL_OF_INT tb#cur_id ~add_spell~ tb#code
        END
        PATCH_IF (~%tb#cur_id%~ STRING_EQUAL ~%tb#code%~) BEGIN // slot free in add_spell.ids
          PATCH_IF (NOT FILE_EXISTS_IN_GAME ~sp%tb#memo%%tb#level%%tb#num%.spl~) BEGIN // no .spl exists with this designation
            SET tb#found_slot = 1
          END
        END
      END
    END
    PATCH_IF (!tb#found_slot) BEGIN
      SET tb#code = (0 - 1)
    END
  END
END

DEFINE_ACTION_MACRO ~TB#ADD_SPELL~ BEGIN
  // check if spell has entry in spell.ids
  OUTER_SET tb#code = IDS_OF_SYMBOL (~spell~ ~%tb#identifier%~)

  // check if spell has entry in add_spell.ids
  OUTER_SET tb#code2 = (0 - 1)
  ACTION_IF (FILE_EXISTS_IN_GAME ~add_spell.ids~) BEGIN
    OUTER_SET tb#code2 = IDS_OF_SYMBOL (~add_spell~ ~%tb#identifier%~)
  END

  LAUNCH_ACTION_FUNCTION ~TB#ADD_SPELL_CHECK_MATCH~ INT_VAR tb#scode = tb#code RET tb#doesmatch = tb#doesmatch END
  ACTION_IF (tb#doesmatch) BEGIN // entry in spell.ids matches level and type
    OUTER_SET tb#newcode = tb#code
    LAUNCH_ACTION_FUNCTION ~TB#ADD_SPELL_CHECK_MATCH~ INT_VAR tb#scode = tb#code2 RET tb#doesmatch2 = tb#doesmatch END
    ACTION_IF (tb#doesmatch2) BEGIN
      // use entry from add_spell.ids
      OUTER_SET tb#newcode = tb#code2
      ACTION_IF (tb#code != tb#code2) BEGIN
        // remove old entry
        COPY_EXISTING ~spell.ids~ ~override~
          REPLACE_TEXTUALLY ~%WNL%~ ~%LNL%~
          REPLACE_TEXTUALLY ~%MNL%~ ~%LNL%~
          REPLACE_TEXTUALLY ~%LNL%[ %TAB%]*[^ %TAB%]+[ %TAB%]+%tb#identifier%[ %TAB%]*$~ ~~
          REPLACE_TEXTUALLY ~%LNL%~ ~%WNL%~
        LAUNCH_ACTION_FUNCTION ~TB#ADD_SPELL_GET_CODE~ INT_VAR tb#scode = tb#code RET tb#filecode = tb#filecode END
        ACTION_IF (tb#use_pld && FILE_EXISTS_IN_GAME ~sp%tb#filecode%.spl~) BEGIN
          COPY_EXISTING ~sp%tb#filecode%.spl~ ~override~
            LAUNCH_PATCH_MACRO TB#ADD_SPELL_PLD
        END
      END
    END
  END
  ELSE BEGIN // no matching entry in spell.ids
    ACTION_IF (tb#code >= 0) BEGIN // existing entry in spell.ids has wrong level/type
      // remove old entry
      COPY_EXISTING ~spell.ids~ ~override~
        REPLACE_TEXTUALLY ~%WNL%~ ~%LNL%~
        REPLACE_TEXTUALLY ~%MNL%~ ~%LNL%~
        REPLACE_TEXTUALLY ~%LNL%[ %TAB%]*[^ %TAB%]+[ %TAB%]+%tb#identifier%[ %TAB%]*$~ ~~
        REPLACE_TEXTUALLY ~%LNL%~ ~%WNL%~
      LAUNCH_ACTION_FUNCTION ~TB#ADD_SPELL_GET_CODE~ INT_VAR tb#scode = tb#code RET tb#filecode = tb#filecode END
      ACTION_IF (tb#use_pld && FILE_EXISTS_IN_GAME ~sp%tb#filecode%.spl~) BEGIN
        COPY_EXISTING ~sp%tb#filecode%.spl~ ~override~
          LAUNCH_PATCH_MACRO TB#ADD_SPELL_PLD
      END
    END
    // determine what slot the new entry will use
    LAUNCH_ACTION_FUNCTION ~TB#ADD_SPELL_CHECK_MATCH~ INT_VAR tb#scode = tb#code2 RET tb#doesmatch2 = tb#doesmatch END
    ACTION_IF (tb#doesmatch2) BEGIN
      // use entry from add_spell.ids
      OUTER_SET tb#newcode = tb#code2
    END
    ELSE BEGIN
      // find a free slot for the spell
      LAUNCH_ACTION_FUNCTION ~TB#ADD_SPELL_FIND_SLOT~ RET tb#newcode = tb#code END
    END
  END

  ACTION_IF (tb#newcode < 0) BEGIN
    PRINT ~Couldn\'t add %tb#identifier% to spell.ids as no slots remain~
  END
  ELSE BEGIN
    // copy .spl
    LAUNCH_ACTION_FUNCTION ~TB#ADD_SPELL_GET_CODE~ INT_VAR tb#scode = tb#newcode RET tb#filecode = tb#filecode END
    ACTION_IF (tb#use_ple && FILE_EXISTS_IN_GAME ~sp%tb#filecode%.spl~) BEGIN
      COPY_EXISTING ~sp%tb#filecode%.spl~ ~override~
        LAUNCH_PATCH_MACRO TB#ADD_SPELL_PLE
    END
    ELSE BEGIN
      COPY ~%tb#source_file%~ ~override/sp%tb#filecode%.spl~
        LAUNCH_PATCH_MACRO TB#ADD_SPELL_PL
    END

    // update spell.ids
    ACTION_IF (tb#code != tb#newcode) BEGIN
      APPEND ~spell.ids~ ~%tb#newcode% %tb#identifier%~
    END

    // update add_spell.ids
    ACTION_IF (tb#code2 != tb#newcode) BEGIN
      ACTION_IF (NOT FILE_EXISTS_IN_GAME ~add_spell.ids~) BEGIN
        COPY + ~.../inlined/null.file~ ~override/add_spell.ids~
      END
      COPY_EXISTING + ~add_spell.ids~ ~override~ // APPEND + ~add_spell.ids~ ~%tb#newcode% %tb#identifier%~
        TEXT_SPRINT tb#append ~%tb#newcode% %tb#identifier%%WNL%~
        INSERT_BYTES SOURCE_SIZE (STRING_LENGTH ~%tb#append%~)
        WRITE_ASCIIE SOURCE_SIZE ~%tb#append%~
      CLEAR_IDS_MAP
    END
  END
END
  ");
(".../WEIDU_NAMESPACE/fl#add_journal_lua.tpa","/**
 *
 * NB: This macro is not public and not included in the backward-compatibility guarantee.
 *
 * This action macro patches the BGEE.LUA of Enhanced Edition games v2.0 or higher with the
 * provided journal entries, so they will be correctly added to the quest tab of the journal.

 * Author: Argent77; edited by Wisp:
 *   not use WITH_TRA
 *   remove as_strref
 *   remove the check for bgee.lua
 *   replace success variable with conditional WARN
 *   convert into macro
 *   conform to doc of ADD_JOURNAL
 *
 * INT_VAR existing   Indicates whether to add entries to an existing journal group.
 *                    Set to 0 if you want to force this macro to create a new journal group
 *                    even if a group of the exact same title already exists.
 *                    Set to non-zero if you want to reuse existing journal groups when available.
 *                    (Default: 0)
 * INT_VAR title      A optional title for the journal group where all entries are added to,
 *                    defined as strref value. title is either -1 or a strref not found in bgee.lua.
 *                    If no title is given then the first line of the first available journal entry
 *                    is used instead.
 * STR_VAR fl#ADD_JOURNAL#entries
 *                    An array of strref values for the respective journal entries that are added
 *                    to the current journal group.
 *                    You can use ACTION_DEFINE_ARRAY or ACTION_DEFINE_ASSOCIATIVE_ARRAY to build
 *                    the array. (Note: This macro uses the value part of associative arrays.)
 */
DEFINE_ACTION_MACRO fl#ADD_JOURNAL_LUA BEGIN
  // determining correct function signature
  ACTION_IF (FILE_CONTAINS_EVALUATED (~bgee.lua~ ~createEntry[%TAB% ]*([%TAB% ]*[^,)]+[%TAB% ]*,[%TAB% ]*[^,)]+[%TAB% ]*,[%TAB% ]*[^,)]+[%TAB% ]*)~)) BEGIN
    OUTER_SET signature = 1
  END ELSE ACTION_IF (FILE_CONTAINS_EVALUATED (~bgee.lua~ ~createEntry[%TAB% ]*([%TAB% ]*[^,)]+[%TAB% ]*,[%TAB% ]*[^,)]+[%TAB% ]*,[%TAB% ]*[^,)]+[%TAB% ]*,[%TAB% ]*[^,)]+[%TAB% ]*,[%TAB% ]*[^,)]+[%TAB% ]*)~)) BEGIN
    OUTER_SET signature = 2
  END ELSE BEGIN
    OUTER_SET signature = 0
  END

  ACTION_IF (signature > 0 AND VARIABLE_IS_SET $fl#ADD_JOURNAL#entries(0)) BEGIN
    // preparing journal title
    ACTION_PHP_EACH fl#ADD_JOURNAL#entries AS _ => strref BEGIN
      ACTION_IF (title < 0) BEGIN
        ACTION_GET_STRREF strref text
        OUTER_PATCH_SAVE title_string ~%text%~ BEGIN
          REPLACE_TEXTUALLY ~^\\(.+?\\)\\([%WNL%%LNL%%MNL%]?.*\\)*$~ ~\\1~
        END
        // remove trailing whitespace and terminal full stops
        OUTER_PATCH_SAVE title_string ~%title_string%~ BEGIN
          REPLACE_TEXTUALLY ~^\\(.*\\)[. %TAB%]$~ ~\\1~
        END
        ACTION_IF (STRING_LENGTH ~%title_string%~ > 0) BEGIN
          OUTER_SET strref_title = RESOLVE_STR_REF (~%title_string%~)
          ACTION_IF !existing AND
                    FILE_CONTAINS_EVALUATED (~bgee.lua~ ~createQuest[%TAB% ]*([%TAB% ]*%strref_title%[%TAB% ]*)~)
          BEGIN
            OUTER_SET strref_title = NEXT_STRREF
            STRING_SET_EVALUATE strref_title ~%title_string%~
          END
          OUTER_SET $fl#ADD_JOURNAL#titles(~%strref%~) = strref_title
        END ELSE FAIL ~ERROR: ADD_JOURNAL could not extract a title string~
      END ELSE OUTER_SET $fl#ADD_JOURNAL#titles(~%strref%~) = title
    END

    // processing journal entries
    COPY_EXISTING ~bgee.lua~ ~override~
      READ_ASCII 0 text ELSE ~~ (SOURCE_SIZE)
      // Determining the correct new line sequence
      LPF fl#A7_GET_NEWLINE STR_VAR text = EVAL ~%text%~ RET newline END

      TEXT_SPRINT createEntry_var ~~
      TEXT_SPRINT createQuest_var ~~
      PATCH_PHP_EACH fl#ADD_JOURNAL#titles AS strref => title BEGIN

        // preparing quest group (doesn\'t add duplicates)
        PATCH_IF (~%text%~ STRING_CONTAINS_REGEXP            ~createQuest[%TAB% ]*([%TAB% ]*%title%[%TAB% ]*)~ = 0) OR
                 (~%createQuest_var%~ STRING_CONTAINS_REGEXP ~createQuest[%TAB% ]*([%TAB% ]*%title%[%TAB% ]*)~ = 0)
        BEGIN
          TEXT_SPRINT createQuest_var ~%createQuest_var%~
        END ELSE BEGIN
          TEXT_SPRINT createQuest_var ~%createQuest_var%%newline%%TAB%createQuest    ( %title% )~
        END

        // prepare associated quest entry
        PATCH_IF (signature = 1) BEGIN
          TEXT_SPRINT createEntry_var ~%createEntry_var%%newline%%TAB%createEntry    ( %title%, %strref%, {} )~
        END ELSE PATCH_IF (signature = 2) BEGIN
          TEXT_SPRINT createEntry_var ~%createEntry_var%%newline%%TAB%createEntry    ( %title%, -1, %strref%, {}, nil )~
        END

      END

      // applying changes to BGEE.LUA
      REPLACE_TEXTUALLY ~\\(create\\(Entry\\|Quest\\).+)\\([%TAB% ]*--[^%WNL%]*\\)?\\)[%WNL%][%WNL%%TAB% ]*end~
                          ~\\1%createQuest_var%%createEntry_var%%newline%end~
    BUT_ONLY
  END ELSE ACTION_IF (signature = 0) BEGIN
    WARN ~WARNING: ADD_JOURNAL was not able to add quest entries~
  END ELSE BEGIN
    WARN ~WARNING: ADD_JOURNAL received no quest entries~
  END
END

// Attempts to determine the new line sequence used in the specified string.
// Defaults to Linux new line.
DEFINE_PATCH_FUNCTION fl#A7_GET_NEWLINE
STR_VAR
  text = ~~
RET
  newline
BEGIN
  PATCH_IF (~%text%~ STRING_CONTAINS_REGEXP ~%WNL%~ = 0) BEGIN
    TEXT_SPRINT newline ~%WNL%~
  END ELSE PATCH_IF (~%text%~ STRING_CONTAINS_REGEXP ~%MNL%~ = 0) BEGIN
    TEXT_SPRINT newline ~%MNL%~
  END ELSE BEGIN
    TEXT_SPRINT newline ~%LNL%~
  END
END
  ");
(".../WEIDU_NAMESPACE/fl#create.tpa","/*
 * At the OCaml level, CREATE defines the variables
 * %FL#CREATE#TYPE%
 * %FL#CREATE#RESREF%
 * %FL#CREATE#VERSION%
 *
 * and the patch macro
 * FL#CREATE#PATCH_LIST
 *
 */

/*
 * Todo: MAKE_BUFF2? Give me a break
 */

DEFINE_ACTION_MACRO FL#CREATE BEGIN
  LAF FL#CREATE#VALIDATE_RESREF
    STR_VAR
      resref = EVAL \"%FL#CREATE#RESREF%\"
      ext = EVAL \"%FL#CREATE#TYPE%\"
  END
  LAF FL#CREATE#MAKE_BUFF
    STR_VAR
      type = EVAL \"%FL#CREATE#TYPE%\"
      version = EVAL \"%FL#CREATE#VERSION%\"
    RET
      FL#CREATE#BUFF = buff
  END

  OUTER_INNER_PATCH_SAVE FL#CREATE#BUFF \"%FL#CREATE#BUFF%\" BEGIN
    SET \"SOURCE_SIZE\" = BUFFER_LENGTH
    LPM FL#CREATE#PATCH_LIST
  END

  LAF FL#CREATE#MAKE_FILE
    STR_VAR
      ext = EVAL \"%FL#CREATE#TYPE%\"
      resref = EVAL \"%FL#CREATE#RESREF%\"
      buff = EVAL \"%FL#CREATE#BUFF%\"
  END
END

//////////////////////////////////////////////////////////////////////

DEFINE_ACTION_FUNCTION FL#CREATE#VALIDATE_RESREF
  STR_VAR
    resref = \"\"
    ext = \"\"
BEGIN
  ACTION_IF \"%resref%\" STRING_MATCHES_REGEXP \".+\\.%ext%$\" = 0 BEGIN
    FAIL ~CREATE: resource reference \"%resref%\" should not contain a file extension~
  END
  ACTION_IF STRING_LENGTH \"%resref%\" > 8 BEGIN
    FAIL ~CREATE: the resource reference \"%resref%\" is longer than 8 characters~
  END
  ACTION_IF STRING_LENGTH \"%resref%\" = 0 BEGIN
    FAIL ~CREATE: empty resource reference~
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#FAIL
  STR_VAR
    filetype = \"\"
    version = \"\"
BEGIN
  FAIL \"CREATE does not know how to create %filetype% of type %version%\"
END

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_BUFF
  STR_VAR
    type = \"\"
    version = \"\"
  RET
    buff
BEGIN
  ACTION_TO_UPPER type
  ACTION_TO_UPPER version
  LAF FL#CREATE#DEFAULT_VERSION STR_VAR type version RET version END
  ACTION_MATCH \"%type%\" WITH
    \"ARE\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF#ARE STR_VAR version RET buff END
    END

    \"CRE\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF#CRE STR_VAR version RET buff END
    END

    \"EFF\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x110 STR_VAR mutator = FL#CREATE#EFF#V20 RET buff END
    END

    \"ITM\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF#ITM STR_VAR version RET buff END
    END

    \"SPL\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF#SPL STR_VAR version RET buff END
    END

    \"STO\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF#STO STR_VAR version RET buff END
    END
    DEFAULT
      FAIL \"CREATE does not know how to create files of type %type%\"
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_BUFF#ARE
  STR_VAR
    version = \"\"
  RET
    buff
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"V1.0\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x11c STR_VAR mutator = FL#CREATE#ARE#V10 RET buff END
    END

    \"V9.1\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x12c STR_VAR mutator = FL#CREATE#ARE#V91 RET buff END
    END

    DEFAULT
      LAF FL#CREATE#FAIL STR_VAR filetype = ARE version END
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_BUFF#CRE
  STR_VAR
    version = \"\"
  RET
    buff
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"V1.0\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x2d4 STR_VAR mutator = FL#CREATE#CRE#V10 RET buff END
    END

    \"V1.2\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x378 STR_VAR mutator = FL#CREATE#CRE#V12 RET buff END
    END

    \"V2.2\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x62e STR_VAR mutator = FL#CREATE#CRE#V22 RET buff END
    END

    \"V9.0\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x33c STR_VAR mutator = FL#CREATE#CRE#V90 RET buff END
    END

    DEFAULT
      LAF FL#CREATE#FAIL STR_VAR filetype = CRE version END
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_BUFF#ITM
  STR_VAR
    version = \"\"
  RET
    buff
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"V1.0\" \"V1\" \"V1  \"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x72 STR_VAR mutator = FL#CREATE#ITM#V10 RET buff END
    END

    \"V1.1\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x9a STR_VAR mutator = FL#CREATE#ITM#V11 RET buff END
    END

    \"V2.0\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x82 STR_VAR mutator = FL#CREATE#ITM#V20 RET buff END
    END

    DEFAULT
      LAF FL#CREATE#FAIL STR_VAR filetype = ITM version END
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_BUFF#SPL
  STR_VAR
    version = \"\"
  RET
    buff
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"V1.0\" \"V1\" \"V1  \"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x72 STR_VAR mutator = FL#CREATE#SPL#V10 RET buff END
    END

    \"V2.0\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x82 STR_VAR mutator = FL#CREATE#SPL#V20 RET buff END
    END

    DEFAULT
      LAF FL#CREATE#FAIL STR_VAR filetype = SPL version END
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_BUFF#STO
  STR_VAR
    version = \"\"
  RET
    buff
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"V1.0\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x9c STR_VAR mutator = FL#CREATE#STO#V10 RET buff END
    END

    \"V1.1\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0x9c STR_VAR mutator = FL#CREATE#STO#V11 RET buff END
    END

    \"V9.0\"
    BEGIN
      LAF FL#CREATE#MAKE_BUFF2 INT_VAR length = 0xf0 STR_VAR mutator = FL#CREATE#STO#V90 RET buff END
    END

    DEFAULT
      LAF FL#CREATE#FAIL STR_VAR filetype = STO version END
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_BUFF2
  INT_VAR
    length = 0
  STR_VAR
    mutator = \"\"
  RET
    buff
BEGIN
  OUTER_INNER_PATCH_SAVE buff \"\" BEGIN
    INSERT_BYTES 0 length
    LPF \"%mutator%\" END
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#DEFAULT_VERSION
  STR_VAR
    type = \"\"
    version = \"\"
  RET
    version
BEGIN
  ACTION_MATCH \"%type%\" WITH
    \"ARE\"
    BEGIN
      LAF FL#CREATE#DEFAULT_VERSION#ARE STR_VAR version RET version END
    END

    \"CRE\"
    BEGIN
      LAF FL#CREATE#DEFAULT_VERSION#CRE STR_VAR version RET version END
    END

    \"ITM\"
    BEGIN
      LAF FL#CREATE#DEFAULT_VERSION#ITM STR_VAR version RET version END
    END

    \"SPL\"
    BEGIN
      LAF FL#CREATE#DEFAULT_VERSION#SPL STR_VAR version RET version END
    END

    \"STO\"
    BEGIN
      LAF FL#CREATE#DEFAULT_VERSION#STO STR_VAR version RET version END
    END

    DEFAULT
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#DEFAULT_VERSION#ARE
  STR_VAR
    version = \"\"
  RET
    version
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"\" WHEN ENGINE_IS ~bg1 totsc soa tob pst iwd how totlm bgee bg2ee iwdee pstee~
    BEGIN
      OUTER_SPRINT version \"V1.0\"
    END

    \"\" WHEN ENGINE_IS ~iwd2~
    BEGIN
      OUTER_SPRINT version \"V9.1\"
    END

    \"\"
    BEGIN
      OUTER_SPRINT version \"V1.0\"
    END

    DEFAULT
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#DEFAULT_VERSION#CRE
  STR_VAR
    version = \"\"
  RET
    version
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"\" WHEN ENGINE_IS ~bg1 totsc soa tob bgee bg2ee iwdee pstee~
    BEGIN
      OUTER_SPRINT version \"V1.0\"
    END

    \"\" WHEN ENGINE_IS ~pst~
    BEGIN
      OUTER_SPRINT version \"V1.2\"
    END

    \"\" WHEN ENGINE_IS ~iwd2~
    BEGIN
      OUTER_SPRINT version \"V2.2\"
    END

    \"\" WHEN ENGINE_IS ~iwd how totlm~
    BEGIN
      OUTER_SPRINT version \"V9.0\"
    END

    \"\"
    BEGIN
      OUTER_SPRINT version \"V1.0\"
    END

    DEFAULT
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#DEFAULT_VERSION#ITM
  STR_VAR
    version = \"\"
  RET
    version
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"\" WHEN ENGINE_IS ~bg1 totsc soa tob iwd how totlm bgee bg2ee iwdee pstee~
    BEGIN
      OUTER_SPRINT version \"V1  \"
    END

    \"\" WHEN ENGINE_IS ~pst~
    BEGIN
      OUTER_SPRINT version \"V1.1\"
    END

    \"\" WHEN ENGINE_IS ~iwd2~
    BEGIN
      OUTER_SPRINT version \"V2.0\"
    END

    \"\"
    BEGIN
      OUTER_SPRINT version \"V1  \"
    END

    DEFAULT
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#DEFAULT_VERSION#SPL
  STR_VAR
    version = \"\"
  RET
    version
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"\" WHEN ENGINE_IS ~bg1 totsc soa tob pst iwd how totlm bgee bg2ee iwdee pstee~
    BEGIN
      OUTER_SPRINT version \"V1  \"
    END

    \"\" WHEN ENGINE_IS ~iwd2~
    BEGIN
      OUTER_SPRINT version \"V2.0\"
    END

    \"\"
    BEGIN
      OUTER_SPRINT version \"V1  \"
    END

    DEFAULT
  END
END

DEFINE_ACTION_FUNCTION FL#CREATE#DEFAULT_VERSION#STO
  STR_VAR
    version = \"\"
  RET
    version
BEGIN
  ACTION_MATCH \"%version%\" WITH
    \"\" WHEN ENGINE_IS ~bg1 totsc soa tob iwd bgee bg2ee iwdee~
    BEGIN
      OUTER_SPRINT version \"V1.0\"
    END

    \"\" WHEN ENGINE_IS ~pst pstee~
    BEGIN
      OUTER_SPRINT version \"V1.1\"
    END

    \"\" WHEN ENGINE_IS ~how totlm iwd2~
    BEGIN
      OUTER_SPRINT version \"V9.0\"
    END

    \"\"
    BEGIN
      OUTER_SPRINT version \"V1.0\"
    END

    DEFAULT
  END
END

<<<<<<<< .../fl-inlined/tmp
>>>>>>>>

DEFINE_ACTION_FUNCTION FL#CREATE#MAKE_FILE
  STR_VAR
    ext = \"\"
    resref = \"\"
    buff = \"\"
BEGIN
  ACTION_TO_LOWER ext
  OUTER_SET count = STRING_LENGTH \"%buff%\"
  PRINT \"Creating file %resref%.%ext%; %count% bytes\"
  COPY ~.../fl-inlined/tmp~ ~override/%resref%.%ext%~
    INSERT_BYTES 0 STRING_LENGTH \"%buff%\"
    WRITE_ASCIIE 0 \"%buff%\"
END

//////////////////////////////////////////////////////////////////////

DEFINE_PATCH_FUNCTION FL#CREATE#ARE#SONGS
  STR_VAR version = \"\"
BEGIN
  DEFINE_ASSOCIATIVE_ARRAY offset_off BEGIN
    \"V1.0\" => 0xbc
    \"V9.1\" => 0xcc
  END
  DEFINE_ASSOCIATIVE_ARRAY update_off BEGIN
    \"V1.0\" => 0xc0
    \"V9.1\" => 0xd0
  END

  READ_LONG $offset_off(\"%version%\") off
  INSERT_BYTES off 0x90
  WRITE_LONG $update_off(\"%version%\") THIS + 0x90
  FOR (o = off + 0x14; o < off + 0x24; o += 0x4) BEGIN
    WRITE_LONG o \"-1\"
  END
END

DEFINE_PATCH_FUNCTION FL#CREATE#ARE#REST
  STR_VAR
    version = \"\"
BEGIN
  DEFINE_ASSOCIATIVE_ARRAY offset_off BEGIN
    \"V1.0\" => 0xc0
    \"V9.1\" => 0xd0
  END

  READ_LONG $offset_off(\"%version%\") off
  INSERT_BYTES off 0xe4
  FOR (i = 0; i < 10; ++i) BEGIN
    WRITE_LONG off + 0x20 + 0x4 * i \"-1\"
  END
END

DEFINE_PATCH_FUNCTION FL#CREATE#ARE#AUTOMAP_NOTE
  STR_VAR
    version = \"\"
BEGIN
  DEFINE_ASSOCIATIVE_ARRAY offset_off BEGIN
    \"V1.0\" => 0xc4
    \"V9.1\" => 0xd4
  END

  PATCH_IF ENGINE_IS pst BEGIN
    WRITE_LONG $offset_off(\"%version%\") 0xFFFFFFFF
    WRITE_LONG $offset_off(\"%version%\") + 0x4 BUFFER_LENGTH
  END ELSE BEGIN
    WRITE_LONG $offset_off(\"%version%\") BUFFER_LENGTH
  END
END

DEFINE_PATCH_FUNCTION FL#CREATE#ARE#V10
  INT_VAR
    length = 0x11c
BEGIN
  WRITE_ASCII 0x00 \"AREAV1.0\"
  PATCH_FOR_EACH off IN 0x54 0x5c 0x60 0x68 0x70 0x78 0x7c 0x84 0x88 0xa0 0xa8 0xb0 0xb8 0xbc 0xc0 BEGIN
    WRITE_LONG off length
  END
  LPF FL#CREATE#ARE#SONGS STR_VAR version = \"V1.0\" END
  LPF FL#CREATE#ARE#REST STR_VAR version = \"V1.0\" END
  LPF FL#CREATE#ARE#AUTOMAP_NOTE STR_VAR version = \"V1.0\" END
END

DEFINE_PATCH_FUNCTION FL#CREATE#ARE#V91
  INT_VAR
    length = 0x12c
BEGIN
  WRITE_ASCII 0x00 \"AREAV9.1\"
  PATCH_FOR_EACH off IN 0x64 0x6c 0x70 0x78 0x80 0x88 0x8c 0x94 0x98 0xb0 0xb8 0xc0 0xc8 0xcc 0xd0 BEGIN
    WRITE_LONG off length
  END
  LPF FL#CREATE#ARE#SONGS STR_VAR version = \"V9.1\" END
  LPF FL#CREATE#ARE#REST STR_VAR version = \"V9.1\" END
  LPF FL#CREATE#ARE#AUTOMAP_NOTE STR_VAR version = \"V9.1\" END
END

DEFINE_PATCH_FUNCTION FL#CREATE#CRE#SPELL_MEM
  STR_VAR
    version = \"\"
BEGIN
  DEFINE_ARRAY V1.0 BEGIN 0x2b0 0x2b8 0x2bc 0x2c4 END
  DEFINE_ARRAY V1.2 BEGIN 0x354 0x35c 0x360 0x368 END
  DEFINE_ARRAY V9.0 BEGIN 0x318 0x320 0x324 0x32c END
  DEFINE_ASSOCIATIVE_ARRAY offset_off BEGIN
    \"V1.0\" => 0x2a8
    \"V1.2\" => 0x34c
    \"V9.0\" => 0x310
  END
  DEFINE_ASSOCIATIVE_ARRAY count_off BEGIN
    \"V1.0\" => 0x2ac
    \"V1.2\" => 0x350
    \"V9.0\" => 0x314
  END

  READ_LONG $offset_off(\"%version%\") offset
  WRITE_LONG $count_off(\"%version%\") 17
  PHP_EACH \"%version%\" AS _ => o BEGIN
    WRITE_LONG o THIS + 0x110
  END
  INSERT_BYTES offset 0x110
  point = 0
  FOR (i = 0; i < 7; ++i) BEGIN // Priest spells
    WRITE_SHORT offset + point i
    point += 0x10
  END
  FOR (i = 0; i < 9; ++i) BEGIN // Wizard spells
    WRITE_SHORT offset + point i
    WRITE_SHORT offset + point + 0x6 1
    point += 0x10
  END
  WRITE_SHORT offset + point + 0x6 2 // Innate spells
END

DEFINE_PATCH_FUNCTION FL#CREATE#CRE#ITEM_SLOT
  STR_VAR
    version = \"\"
BEGIN
  DEFINE_ASSOCIATIVE_ARRAY offset_off BEGIN
    \"V1.0\" => 0x2b8
    \"V1.2\" => 0x35c
    \"V2.2\" => 0x612
    \"V9.0\" => 0x320
  END
  DEFINE_ASSOCIATIVE_ARRAY slots_count BEGIN
    \"V1.0\" => 40
    \"V1.2\" => 48
    \"V2.2\" => 52
    \"V9.0\" => 40
  END

  READ_LONG $offset_off(\"%version%\") offset
  INSERT_BYTES offset $slots_count(\"%version%\") * 2
  FOR (i = 0; i < $slots_count(\"%version%\") - 2; ++i) BEGIN
    WRITE_SHORT offset + i * 2 \"-1\"
  END

END

DEFINE_PATCH_FUNCTION FL#CREATE#CRE#V10
  INT_VAR
    length = 0x2d4
BEGIN
  WRITE_ASCII 0x000 \"CRE V1.0\"
  WRITE_LONG  0x008 \"-1\"
  WRITE_LONG  0x00c \"-1\"
  WRITE_BYTE  0x033 ENGINE_IS ~bg1 totsc pst iwd how totlm iwd2~ ? 0 : 1
  FOR (off = 0xa4; off < 0x234; off += 0x4) BEGIN
    WRITE_LONG off \"-1\"
  END
  WRITE_SHORT 0x27c \"-1\"
  WRITE_SHORT 0x27e \"-1\"
  WRITE_LONG  0x2a0 length
  WRITE_LONG  0x2a8 length
  WRITE_LONG  0x2b0 length
  WRITE_LONG  0x2b8 length
  WRITE_LONG  0x2bc length
  WRITE_LONG  0x2c4 length
  LPF FL#CREATE#CRE#SPELL_MEM STR_VAR version = \"V1.0\" END
  LPF FL#CREATE#CRE#ITEM_SLOT STR_VAR version = \"V1.0\" END
END

DEFINE_PATCH_FUNCTION FL#CREATE#CRE#V12
  INT_VAR
    length = 0x378
BEGIN
  WRITE_ASCII 0x000 \"CRE V1.2\"
  WRITE_LONG  0x008 \"-1\"
  WRITE_LONG  0x00c \"-1\"
  FOR (off = 0xa4; off < 0x234; off += 0x4) BEGIN
    WRITE_LONG off \"-1\"
  END
  WRITE_SHORT 0x320 \"-1\"
  WRITE_SHORT 0x322 \"-1\"
  WRITE_LONG  0x344 length
  WRITE_LONG  0x34c length
  WRITE_LONG  0x354 length
  WRITE_LONG  0x35c length
  WRITE_LONG  0x360 length
  WRITE_LONG  0x368 length
  LPF FL#CREATE#CRE#SPELL_MEM STR_VAR version = \"V1.2\" END
  LPF FL#CREATE#CRE#ITEM_SLOT STR_VAR version = \"V1.2\" END
END

DEFINE_PATCH_FUNCTION FL#CREATE#CRE#V22
  INT_VAR
    length = 0x62e
BEGIN
  WRITE_ASCII 0x000 \"CRE V2.2\"
  WRITE_LONG  0x008 \"-1\"
  WRITE_LONG  0x00c \"-1\"
  FOR (off = 0xac; off < 0x1ac; off += 0x4) BEGIN
    WRITE_LONG off \"-1\"
  END
  WRITE_SHORT 0x390 \"-1\"
  WRITE_SHORT 0x392 \"-1\"

  FOR (off = 0x3ba; off < 0x4b6; off += 0x4) BEGIN
    WRITE_LONG off length
  END
  FOR (off = 0x5b2; off < 0x5d6; off += 0x4) BEGIN
    WRITE_LONG off length
  END
  WRITE_LONG 0x5fa length
  WRITE_LONG 0x602 length
  WRITE_LONG 0x60a length
  WRITE_LONG 0x612 length
  WRITE_LONG 0x616 length
  WRITE_LONG 0x61e length

  LPF FL#CREATE#CRE#V22#SPELL_MEM END
  LPF FL#CREATE#CRE#ITEM_SLOT STR_VAR version = \"V2.2\" END
END

DEFINE_PATCH_FUNCTION FL#CREATE#CRE#V22#SPELL_MEM BEGIN
  READ_LONG 0x3ba off
  INSERT_BYTES off 0x258
  count = 0
  FOR (off = 0x3ba; off < 0x4b6; off += 0x4) BEGIN
    WRITE_LONG off THIS + count * 0x8
    ++count
  END
  FOR (off = 0x5b2; off < 0x5d6; off += 0x4) BEGIN
    WRITE_LONG off THIS + count * 0x8
    ++count
  END
  PATCH_FOR_EACH off IN 0x5fa 0x602 0x60a BEGIN
    WRITE_LONG off THIS + count * 0x8
    ++count
  END
  PATCH_FOR_EACH off IN 0x612 0x616 0x61e BEGIN
    WRITE_LONG off THIS + count * 0x8
  END
END

DEFINE_PATCH_FUNCTION FL#CREATE#CRE#V90
  INT_VAR
    length = 0x33c
BEGIN
  WRITE_ASCII 0x000 \"CRE V9.0\"
  WRITE_LONG  0x008 \"-1\"
  WRITE_LONG  0x00c \"-1\"
  FOR (off = 0xa4; off < 0x234; off += 0x4) BEGIN
    WRITE_LONG off \"-1\"
  END
  WRITE_SHORT 0x2e4 \"-1\"
  WRITE_SHORT 0x2e6 \"-1\"
  WRITE_LONG  0x308 length
  WRITE_LONG  0x310 length
  WRITE_LONG  0x318 length
  WRITE_LONG  0x320 length
  WRITE_LONG  0x324 length
  WRITE_LONG  0x32c length
  LPF FL#CREATE#CRE#SPELL_MEM STR_VAR version = \"V9.0\" END
  LPF FL#CREATE#CRE#ITEM_SLOT STR_VAR version = \"V9.0\" END
END

DEFINE_PATCH_FUNCTION FL#CREATE#EFF#V20 BEGIN
  WRITE_ASCII 0x00 \"EFF V2.0\"
  WRITE_ASCII 0x08 \"EFF V2.0\"
  WRITE_LONG  0x80 \"-1\"
  WRITE_LONG  0x84 \"-1\"
  WRITE_LONG  0x88 \"-1\"
  WRITE_LONG  0x8c \"-1\"
END

DEFINE_PATCH_FUNCTION FL#CREATE#ITM#V10
  INT_VAR
    length = 0x72
BEGIN
  WRITE_ASCII 0x00 \"ITM V1  \"
  WRITE_LONG  0x08 \"-1\"
  WRITE_LONG  0x0c \"-1\"
  WRITE_LONG  0x50 \"-1\"
  WRITE_LONG  0x54 \"-1\"
  WRITE_LONG  0x64 length
  WRITE_LONG  0x6a length
END

DEFINE_PATCH_FUNCTION FL#CREATE#ITM#V11
  INT_VAR
    length = 0x9a
BEGIN
  LPF FL#CREATE#ITM#V10 INT_VAR length END
  WRITE_ASCII 0x00 \"ITM V1.1\"
  WRITE_LONG  0x7a \"-1\"
END

DEFINE_PATCH_FUNCTION FL#CREATE#ITM#V20 BEGIN
  LPF FL#CREATE#ITM#V10 INT_VAR length = 0x82 END
  WRITE_ASCII 0x00 \"ITM V2.0\"
END

DEFINE_PATCH_FUNCTION FL#CREATE#SPL#V10
  INT_VAR
    length = 0x72
BEGIN
  WRITE_ASCII 0x00 \"SPL V1  \"
  WRITE_LONG  0x08 \"-1\"
  WRITE_LONG  0x0c \"-1\"
  WRITE_LONG  0x50 \"-1\"
  WRITE_LONG  0x54 \"-1\"
  WRITE_LONG  0x64 length
  WRITE_LONG  0x6a length
END

DEFINE_PATCH_FUNCTION FL#CREATE#SPL#V20 BEGIN
  LPF FL#CREATE#SPL#V10 INT_VAR length = 0x82 END
  WRITE_ASCII 0x00 \"SPL V2.0\"
END

DEFINE_PATCH_FUNCTION FL#CREATE#STO#V10
  INT_VAR
    length = 0x9c
BEGIN
  WRITE_ASCII 0x00 \"STORV1.0\"
  WRITE_LONG  0x0c \"-1\"
  WRITE_LONG  0x2c length
  WRITE_LONG  0x34 length
  WRITE_LONG  0x4c length
  WRITE_LONG  0x70 length
END

DEFINE_PATCH_FUNCTION FL#CREATE#STO#V11 BEGIN
  LPF FL#CREATE#STO#V10 END
  WRITE_ASCII 0x00 \"STORV1.1\"
END

DEFINE_PATCH_FUNCTION FL#CREATE#STO#V90 BEGIN
  LPF FL#CREATE#STO#V10 INT_VAR length = 0xf0 END
  WRITE_ASCII 0x00 \"STORV9.0\"
END
  ");
(".../WEIDU_NAMESPACE/lc_fix_missile_ids.tpa","//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\
//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\
//\\\\                                                    //\\\\
//\\\\   Update Missile, Projectile, and Fireball Macro   //\\\\
//\\\\   Written by Robert Rath (aka Galactygon)          //\\\\
//\\\\                                                    //\\\\
//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\
//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\//\\\\

// This macro is written specifically with Baldur\'s Gate II: Throne of Bhaal in mind,
// but parts of it apply to other games.

// This macro will do what Black Isle left out: update the MISSILE.IDS, PROJECTL.IDS, and
// FIREBALL.IDS with entries used specifically in ToB.

// This macro will continuously look for discrepancies between the PROJECTL.IDS and MISSILE.IDS
// regardless of what game is installed (BG1, BG2, IWD1, IWD2, PST), provided those two files exist.
// These discrepancies mean if the last entry of the MISSILE.IDS is not one value more than the last
// entry of the PROJECTL.IDS, it will update either one or the other with blank \"Unnamed\" entries.

// If the macro is fully able to update the PROJECTL.IDS and MISSILE.IDS (ie no mod
// overwrites the ToB entries), the macro will copy a file \"TOB_MISSILE_PROJECTL.xxx\"
// to the override folder.

// In the event that it is unable to fully update the aforementioned IDS files, the macro will attempt
// to do so once each time the user enters WeiDU.

// If you wish to prevent this macro from running, set the variables
// \"append_projectl_size\" and \"append_missile_size\" to 0.

DEFINE_ACTION_FUNCTION fl#weidu#donotpolluteglobalnamespaceplease BEGIN
  OUTER_SET fully_updated_projectl = 0
  OUTER_SET fully_updated_missile = 0

  ACTION_IF ( !VARIABLE_IS_SET append_projectl_size AND ENGINE_IS TOB ) BEGIN

    OUTER_SET $append_projectl(\"0\" \"0\") = 264
    OUTER_SPRINT $append_projectl(\"0\" \"1\") \"STRMVENG\"
    OUTER_SET $append_projectl(\"1\" \"0\") = 266
    OUTER_SPRINT $append_projectl(\"1\" \"1\") \"TRAPSPIK\"
    OUTER_SET $append_projectl(\"2\" \"0\") = 267
    OUTER_SPRINT $append_projectl(\"2\" \"1\") \"TRAPTIME\"
    OUTER_SET $append_projectl(\"3\" \"0\") = 268
    OUTER_SPRINT $append_projectl(\"3\" \"1\") \"TRAPBOOM\"
    OUTER_SET $append_projectl(\"4\" \"0\") = 269
    OUTER_SPRINT $append_projectl(\"4\" \"1\") \"SPDRBRTH\"
    OUTER_SET $append_projectl(\"5\" \"0\") = 270
    OUTER_SPRINT $append_projectl(\"5\" \"1\") \"SPENBLD\"
    OUTER_SET $append_projectl(\"6\" \"0\") = 271
    OUTER_SPRINT $append_projectl(\"6\" \"1\") \"DRAGGREE\"
    OUTER_SET $append_projectl(\"7\" \"0\") = 272
    OUTER_SPRINT $append_projectl(\"7\" \"1\") \"GREEHIT\"
    OUTER_SET append_projectl_size = 8

  END

  ACTION_IF ( !VARIABLE_IS_SET append_missile_size AND ENGINE_IS TOB ) BEGIN

    OUTER_SET $append_missile(\"0\" \"0\") = 265
    OUTER_SPRINT $append_missile(\"0\" \"1\") \"Storm of Vengeance\"
    OUTER_SET $append_missile(\"1\" \"0\") = 266
    OUTER_SPRINT $append_missile(\"1\" \"1\") \"Comet\"
    OUTER_SET $append_missile(\"2\" \"0\") = 267
    OUTER_SPRINT $append_missile(\"2\" \"1\") \"Spike Trap\"
    OUTER_SET $append_missile(\"3\" \"0\") = 268
    OUTER_SPRINT $append_missile(\"3\" \"1\") \"Time Trap\"
    OUTER_SET $append_missile(\"4\" \"0\") = 269
    OUTER_SPRINT $append_missile(\"4\" \"1\") \"Exploding Trap\"
    OUTER_SET $append_missile(\"5\" \"0\") = 270
    OUTER_SPRINT $append_missile(\"5\" \"1\") \"Dragon\'s Breath\"
    OUTER_SET $append_missile(\"6\" \"0\") = 271
    OUTER_SPRINT $append_missile(\"6\" \"1\") \"Energy Blades\"
    OUTER_SET $append_missile(\"7\" \"0\") = 272
    OUTER_SPRINT $append_missile(\"7\" \"1\") \"Green Dragon Breath\"
    OUTER_SET $append_missile(\"8\" \"0\") = 273
    OUTER_SPRINT $append_missile(\"8\" \"1\") \"Green Dragon HIT\"
    OUTER_SET append_missile_size = 9

  END

  ACTION_IF ( !VARIABLE_IS_SET updated_missile_and_projectl AND ENGINE_IS TOB AND !FILE_EXISTS_IN_GAME \"TOB_MISSILE_PROJECTL.xxx\" ) BEGIN

    ACTION_IF (VARIABLE_IS_SET append_missile_size) BEGIN
      OUTER_SET append_missile_size_minusone = append_missile_size - 1
      ACTION_IF (append_missile_size > 0 AND VARIABLE_IS_SET $append_missile(\"%append_missile_size_minusone%\" \"1\")) BEGIN
        COPY_EXISTING ~MISSILE.ids~ ~override~
          SET previous_entry = 0
          SET next_entry = 0
          COUNT_2DA_ROWS 0 missile_rowcount
          FOR (row = 1; row < missile_rowcount; row += 1) BEGIN
            SET rowminusone = row - 1
            READ_2DA_ENTRY rowminusone 0 0 \"previous_entry\"
            READ_2DA_ENTRY row 0 0 \"next_entry\"
            FOR (appendloops = append_missile_size; appendloops > 0; appendloops -= 1) BEGIN
              SET appendloops -= 1
              PATCH_IF ( IS_AN_INT previous_entry AND IS_AN_INT next_entry ) BEGIN
                PATCH_IF ( previous_entry != 0 AND next_entry != 0 ) BEGIN
                  PATCH_IF (previous_entry < $append_missile(\"%appendloops%\" \"0\") AND next_entry > $append_missile(\"%appendloops%\" \"0\")) BEGIN
                    SET append_col1 = $append_missile(\"%appendloops%\" \"0\")
                    SPRINT append_col2 $append_missile(\"%appendloops%\" \"1\")
                    INSERT_2DA_ROW row 1 \"%append_col1% %append_col2%\"
                    SET missile_rowcount += 1
                  END
                END
              END
              SET appendloops += 1
            END
          END
        BUT_ONLY_IF_IT_CHANGES
      END
    END

    ACTION_IF (VARIABLE_IS_SET append_projectl_size) BEGIN
      OUTER_SET append_projectl_size_minusone = append_projectl_size - 1
      ACTION_IF (append_projectl_size > 0 AND VARIABLE_IS_SET $append_missile(\"%append_projectl_size_minusone%\" \"1\")) BEGIN
        COPY_EXISTING ~PROJECTL.ids~ ~override~
          SET previous_entry = 0
          SET next_entry = 0
          COUNT_2DA_ROWS 0 projectl_rowcount
          FOR (row = 1; row < projectl_rowcount; row += 1) BEGIN
            SET rowminusone = row - 1
            READ_2DA_ENTRY rowminusone 0 0 \"previous_entry\"
            READ_2DA_ENTRY row 0 0 \"next_entry\"
            FOR (appendloops = append_projectl_size; appendloops > 0; appendloops -= 1) BEGIN
              SET appendloops -= 1
              PATCH_IF ( IS_AN_INT previous_entry AND IS_AN_INT next_entry ) BEGIN
                PATCH_IF ( previous_entry != 0 AND next_entry != 0 ) BEGIN
                  PATCH_IF (previous_entry < $append_projectl(\"%appendloops%\" \"0\") AND next_entry > $append_projectl(\"%appendloops%\" \"0\")) BEGIN
                    SET append_col1 = $append_projectl(\"%appendloops%\" \"0\")
                    SPRINT append_col2 $append_projectl(\"%appendloops%\" \"1\")
                    INSERT_2DA_ROW row 1 \"%append_col1% %append_col2%\"
                    SET missile_rowcount += 1
                  END
                END
              END
              SET appendloops += 1
            END
          END
        BUT_ONLY_IF_IT_CHANGES
      END
    END
    OUTER_FOR (appendloops = 0; appendloops < append_projectl_size; appendloops += 1) BEGIN
      OUTER_SET append_col1 = $append_projectl(\"%appendloops%\" \"0\")
      OUTER_SPRINT append_col2 $append_projectl(\"%appendloops%\" \"1\")
      APPEND ~PROJECTL.IDS~ ~%append_col1% %append_col2%~
      UNLESS ~%append_col1%~
    END

    OUTER_FOR (appendloops = 0; appendloops < append_missile_size; appendloops += 1) BEGIN
      OUTER_SET append_col1 = $append_missile(\"%appendloops%\" \"0\")
      OUTER_SPRINT append_col2 $append_missile(\"%appendloops%\" \"1\")
      APPEND ~MISSILE.IDS~ ~%append_col1% %append_col2%~
      UNLESS ~%append_col1%~
    END

    ACTION_IF (append_projectl_size > 0) BEGIN
      COPY_EXISTING ~PROJECTL.IDS~ ~override~
        COUNT_2DA_ROWS 2 projectl_rowcount
        FOR (row = 0; row < projectl_rowcount; row += 1) BEGIN
          READ_2DA_ENTRY row 0 2 \"projectl_value\"
          PATCH_IF ( VARIABLE_IS_SET projectl_value ) BEGIN
            PATCH_IF ( IS_AN_INT projectl_value ) BEGIN
              READ_2DA_ENTRY row 1 2 \"projectl_identifier\"
              FOR (checkloops = 0; checkloops < append_projectl_size AND fully_updated_projectl < append_projectl_size; checkloops += 1) BEGIN
                PATCH_IF ( projectl_value = $append_projectl(\"%checkloops%\" \"0\") AND \"%projectl_identifier%\" STRING_COMPARE_CASE $append_projectl(\"%checkloops%\" \"1\") = 0 ) BEGIN
                  SET fully_updated_projectl += 1
                END
              END
            END
          END
        END
      BUT_ONLY_IF_IT_CHANGES
    END

    ACTION_IF (append_missile_size > 0) BEGIN
      COPY_EXISTING ~MISSILE.IDS~ ~override~
        COUNT_2DA_ROWS 2 missile_rowcount
        FOR (row = 0; row < missile_rowcount; row += 1) BEGIN
          READ_2DA_ENTRY row 0 2 \"missile_value\"
          PATCH_IF ( VARIABLE_IS_SET missile_value ) BEGIN
            PATCH_IF ( IS_AN_INT missile_value ) BEGIN
              READ_2DA_ENTRY row 1 2 \"missile_identifier\"
              FOR (checkloops = 0; checkloops < append_missile_size AND fully_updated_missile < append_missile_size; checkloops += 1) BEGIN
                PATCH_IF ( missile_value = $append_missile(\"%checkloops%\" \"0\") AND $append_missile(\"%checkloops%\" \"1\") STRING_MATCHES_REGEXP \"%missile_identifier%.*\" = 0 ) BEGIN
                  SET fully_updated_missile += 1
                END
              END
            END
          END
        END
      BUT_ONLY_IF_IT_CHANGES
    END

    ACTION_IF ( fully_updated_missile = append_missile_size AND fully_updated_projectl = append_projectl_size ) BEGIN
      COPY_EXISTING ~SW1H01.itm~ ~override/TOB_MISSILE_PROJECTL.xxx~
    END

    APPEND ~FIREBALL.IDS~ ~18 DRAGONACID~
    UNLESS ~18~
    APPEND ~FIREBALL.IDS~ ~17 DRAGONPURPLEFIRE~
    UNLESS ~17~

    OUTER_SET updated_missile_and_projectl = 0

  END

  COPY_EXISTING ~MISSILE.ids~ ~override~
    COUNT_2DA_ROWS 1 missile_rowcount
    SET missile_rowcount -= 1
    READ_2DA_ENTRY missile_rowcount 0 0 last_missile_entry
  BUT_ONLY_IF_IT_CHANGES
  COPY_EXISTING ~PROJECTL.ids~ ~override~
    COUNT_2DA_ROWS 1 projectl_rowcount
    SET projectl_rowcount -= 1
    READ_2DA_ENTRY projectl_rowcount 0 0 last_projectl_entry
  BUT_ONLY_IF_IT_CHANGES

  OUTER_WHILE ( last_projectl_entry < last_missile_entry - 1) BEGIN
    OUTER_SET last_projectl_entry = last_projectl_entry + 1
    APPEND ~PROJECTL.IDS~ ~%last_projectl_entry% ~
  END
  OUTER_WHILE ( last_projectl_entry > last_missile_entry - 1) BEGIN
    OUTER_SET last_missile_entry = last_missile_entry + 1
    APPEND ~MISSILE.IDS~ ~%last_missile_entry% Unnamed~
  END

END

ACTION_IF ( FILE_EXISTS_IN_GAME \"MISSILE.IDS\" AND
            FILE_EXISTS_IN_GAME \"PROJECTL.IDS\" AND
            FILE_EXISTS_IN_GAME \"FIREBALL.IDS\" ) BEGIN
  LAF fl#weidu#donotpolluteglobalnamespaceplease END
END
  ");
(".../WEIDU_NAMESPACE/tb#pretty_print.tpp","READ_2DA_ENTRY tb#pretty_print_indent + 1 0 0 tb#pretty_print_dmp
SET_2DA_ENTRY_LATER tb#pretty_print_dmp2 tb#pretty_print_indent + 1 0 ~%tb#pretty_print_dmp%~
SET_2DA_ENTRIES_NOW tb#pretty_print_dmp2 0
READ_2DA_ENTRY tb#pretty_print_indent 0 0 ~tb#pretty_print_header~
READ_2DA_ENTRY tb#pretty_print_indent + 1 0 0 fl#pretty_print_spacefodder
REPLACE_EVALUATE ~^\\(%fl#pretty_print_spacefodder%  *\\)~ BEGIN
  SPACES somespace ~%MATCH1%~
END ~%MATCH1%~
SET_2DA_ENTRY tb#pretty_print_indent 0 0 ~%somespace%%tb#pretty_print_header%~
  ");
(".../WEIDU_NAMESPACE/a7_pvrz.tpa","/*
Author: argent77

Summary:
Functions for installing custom PVRZ-based BAM and MOS resources in Enhanced Edition games.

Available functions:
UPDATE_PVRZ_INDICES   Patch function. Updates the PVRZ references in the BAM v2 or MOS v2 file to the next
                         contiguous block of free PVRZ indices.
INSTALL_PVRZ          Action function. Installs a PVRZ file and updates the PVRZ index. Use in conjunction
                         with \"UPDATE_PVRZ_INDICES\".
FIND_FREE_PVRZ_INDEX  Patch or action function. Attempts to find a contiguous block of free PVRZ indices
                         in the game installation.

Examples
~~~~~~~~

Example 1: Installing the file \"mypic.bam\" and associated mos0000.pvrz, mos0001.pvrz, mos0002.pvrz
           located in the folder \"mymod/bam\".

// Installing BAM resource
COPY ~mymod/bam/mypic.bam~ ~override~
  LPF ~UPDATE_PVRZ_INDICES~
    RET
      original_base_index
      new_base_index
    END

// It is strongly recommended to check the return values of \"UPDATE_PVRZ_INDICES\".
ACTION_IF (original_base_index >= 0 && new_base_index >= 0) BEGIN
  // Installing associated PVRZ resources
  ACTION_FOR_EACH file IN ~mos0000.pvrz~ ~mos0001.pvrz~ ~mos0002.pvrz~
    LAF ~INSTALL_PVRZ~
      INT_VAR
        original_base_index = original_base_index
        new_base_index      = new_base_index
      STR_VAR
        source_file         = EVAL ~mymod/bam/%file%~
    END
  END
END

In a clean game installation, this script portion will copy all files into the override folder of the game,
rename the PVRZ files to mos1000.pvrz, mos1001.pvrz, mos1002.pvrz and update the PVRZ references in
\"mypic.bam\" accordingly.


Example 2: Installing the files \"mypic1.mos\" and \"mypic2.mos\" which share a single PVRZ file.
           \"mypic1.mos\" references mos0000.pvrz, mos0001.pvrz and mos0002.pvrz.
           \"mypic2.mos\" references mos0002.pvrz and mos0003.pvrz.

// Installing MOS resource 1
COPY ~mymod/mos/mypic1.mos~ ~override~
  LPF ~UPDATE_PVRZ_INDICES~
    RET
      original_base_index
      new_base_index
    END

ACTION_IF (original_base_index >= 0 && new_base_index >= 0) BEGIN
  // Installing PVRZ resources associated with \"mypic1.mos\"
  ACTION_FOR_EACH file IN ~mos0000.pvrz~ ~mos0001.pvrz~ ~mos0002.pvrz~
    LAF ~INSTALL_PVRZ~
      INT_VAR
        original_base_index = original_base_index
        new_base_index      = new_base_index
      STR_VAR
        source_file         = EVAL ~mymod/mos/%file%~
    END
  END
END

// Installing MOS resource 2
COPY ~mymod/mos/mypic2.mos~ ~override~
  LPF ~UPDATE_PVRZ_INDICES~
    RET
      original_base_index
      new_base_index
    END

ACTION_IF (original_base_index >= 0 && new_base_index >= 0) BEGIN
  // Installing PVRZ resources associated with \"mypic2.mos\"
  ACTION_FOR_EACH file IN ~mos0002.pvrz~ ~mos0003.pvrz~
    LAF ~INSTALL_PVRZ~
      INT_VAR
        original_base_index = original_base_index
        new_base_index      = new_base_index
      STR_VAR
        source_file         = EVAL ~mymod/mos/%file%~
    END
  END
END

The function \"UPDATE_PVRZ_INDICES\" does not directly support MOS or BAM files with shared PVRZ files.
As a result, copies of the shared PVRZ files will be installed for each affected MOS or BAM file.
*/


/**
 * This patch function updates all PVRZ references in the BAM v2 or MOS v2 file to the next unoccupied block of
 * PVRZ indices. This function is intended to be used in combination with the action function \"INSTALL_PVRZ\".
 *
 * INT_VAR target_base_index  Optional parameter. When specified, the function attempts to use a block of free
 *                            PVRZ indices starting at the specified value. Default: 1000.
 * RET original_base_index    Returns the lowest PVRZ index used by the source BAM or MOS. Returns -1 on error.
 * RET new_base_index         Returns the lowest PVRZ index used by the target BAM or MOS. Returns -1 on error.
 * RET index_range            Returns the range of reserved PVRZ indices, i.e. the difference between the smallest
 *                            and biggest PVRZ index inclusive. Returns 0 on error.
 */
DEFINE_PATCH_FUNCTION ~UPDATE_PVRZ_INDICES~
  INT_VAR
    target_base_index = 1000
  RET
    original_base_index
    new_base_index
    index_range
BEGIN
  SET source_base_index = \"-1\"
  SET original_base_index = \"-1\"
  SET new_base_index = \"-1\"
  SET index_range = 0
  PATCH_IF (ENGINE_IS ~bgee bg2ee iwdee pstee~) BEGIN
    SET is_valid = 0   // determines whether the file is a valid BAM or MOS file
    READ_ASCII 0x00 header_id ( 8 )
    PATCH_IF (~BAM V2  ~ STRING_EQUAL ~%header_id%~) BEGIN
      READ_LONG 0x08 header_frames
      READ_LONG 0x0c header_cycles
      READ_LONG 0x10 header_blocks
      READ_LONG 0x14 header_ofs_frames
      READ_LONG 0x18 header_ofs_cycles
      READ_LONG 0x1c header_ofs_blocks
      PATCH_IF (header_frames > 0 && header_cycles > 0 && header_blocks > 0 &&
                header_ofs_frames >= 0x20 && header_ofs_cycles >= 0x20 && header_ofs_blocks >= 0x20) BEGIN
        SET is_valid = 1
      END
    END ELSE PATCH_IF (~MOS V2  ~ STRING_EQUAL ~%header_id%~) BEGIN
      READ_LONG 0x08 header_width
      READ_LONG 0x0c header_height
      READ_LONG 0x10 header_blocks
      READ_LONG 0x14 header_ofs_blocks
      PATCH_IF (header_width > 0 && header_height > 0 && header_ofs_blocks >= 0x18) BEGIN
        SET is_valid = 1
      END
    END

    PATCH_IF (is_valid > 0) BEGIN
      // getting pvrz index range
      LPF ~a7#__find_pvrz_index_range~ INT_VAR num_blocks = header_blocks ofs_blocks = header_ofs_blocks RET min_index max_index END

      // determining block of free PVRZ indices
      PATCH_IF (min_index >= 0 && max_index >= 0) BEGIN
        SET num_indices = max_index - min_index + 1
        PATCH_IF (target_base_index < 0 || target_base_index > 99999) BEGIN
          PATCH_LOG ~Target base index (%target_base_index%) is out of range. Using default value.~
          target_base_index = 1000
        END
        LPF ~FIND_FREE_PVRZ_INDEX~ INT_VAR num_to_reserve = num_indices start_index = target_base_index RET free_index END
        PATCH_IF (free_index >= 0) BEGIN
          SET source_base_index = min_index
          SET target_base_index = free_index
        END ELSE BEGIN
          SET source_base_index = \"-1\"
          SET target_base_index = \"-1\"
          PATCH_WARN ~Unable to find free block of PVRZ indices. No changes have been made.~
        END
      END ELSE BEGIN
        SET source_base_index = \"-1\"
        SET target_base_index = \"-1\"
        PATCH_WARN ~Unable to parse data blocks. No changes have been made.~
      END

      // updating pvrz indices
      PATCH_IF (source_base_index >= 0 && target_base_index >= 0) BEGIN
        LPF ~a7#__update_pvrz_indices~
          INT_VAR
            num_blocks = header_blocks
            ofs_blocks = header_ofs_blocks
            source_base_index = source_base_index
            target_base_index = target_base_index
          RET
            original_base_index
            new_base_index
        END
        PATCH_IF (original_base_index >= 0 && new_base_index >= 0) BEGIN
          SET index_range = num_indices
        END ELSE BEGIN
          PATCH_WARN ~Unable to update PVRZ indices. No changes have been made.~
        END
      END
    END ELSE BEGIN
      PATCH_WARN ~Invalid or corrupted BAM V2 or MOS V2 resource found. No changes have been made.~
    END
  END
END


/**
 * Copies the specified PVRZ file into the target folder and updates the PVRZ index.
 * This function should be used in conjunction with \"UPDATE_PVRZ_INDICES\".
 *
 * INT_VAR original_base_index  The current base index (returned by the function \"UPDATE_PVRZ_INDICES\" as
 *                              \"original_base_index\").
 * INT_VAR new_base_index       The new base index (returned by the function \"UPDATE_PVRZ_INDICES\" as
 *                              \"new_base_index\").
 * STR_VAR source_file          The source file to copy. The filename must match the regular expression
 *                              \"MOS[0-9]{4,5}\\.PVRZ\" (e.g. MOS0000.PVRZ, mos1592.pvrz or Mos12345.PVRZ).
 *                              Case is ignored.
 * STR_VAR target_folder        The target folder to copy the source file into. (Default: \"override\")
 * RET success                  Set to non-zero if the function returned successfully and set to zero on error.
 * RET SOURCE_*, DEST_*         Returns all variables that are automatically set by the COPY action on success.
 */
DEFINE_ACTION_FUNCTION ~INSTALL_PVRZ~
  INT_VAR
    original_base_index = \"-1\"
    new_base_index = \"-1\"
  STR_VAR
    source_file = ~~
    target_folder = ~override~
  RET
    success
    SOURCE_DIRECTORY SOURCE_FILESPEC SOURCE_FILE SOURCE_RES SOURCE_EXT SOURCE_SIZE
    DEST_DIRECTORY DEST_FILESPEC DEST_FILE DEST_RES DEST_EXT
BEGIN
  OUTER_SET success = 0
  ACTION_IF (ENGINE_IS ~bgee bg2ee iwdee pstee~) BEGIN
    ACTION_IF ((NOT ~%source_file%~ STRING_EQUAL ~~) && (NOT ~%target_folder%~ STRING_EQUAL ~~) &&
               original_base_index >= 0 && new_base_index >= 0) BEGIN
      ACTION_IF ((~%source_file%~ STRING_CONTAINS_REGEXP ~[Mm][Oo][Ss][0-9][0-9][0-9][0-9][0-9]?\\.[Pp][Vv][Rr][Zz]$~) == 0) BEGIN
        // extracting pvrz index from filename
        OUTER_INNER_PATCH \"%source_file%\" BEGIN
          digit1    = (BYTE_AT (BUFFER_LENGTH - 6)) - 48
          digit10   = (BYTE_AT (BUFFER_LENGTH - 7)) - 48
          digit100  = (BYTE_AT (BUFFER_LENGTH - 8)) - 48
          digit1000 = (BYTE_AT (BUFFER_LENGTH - 9)) - 48
          digit_ex  = (BYTE_AT (BUFFER_LENGTH - 10)) - 48   // extra digit in case of a 5-digits number
          PATCH_IF (digit_ex < 0 || digit_ex > 9) BEGIN
            SET digit_ex = 0
          END
        END

        ACTION_IF (digit1    >= 0 && digit1    <= 9 &&
                   digit10   >= 0 && digit10   <= 9 &&
                   digit100  >= 0 && digit100  <= 9 &&
                   digit1000 >= 0 && digit1000 <= 9 &&
                   digit_ex   >= 0 && digit_ex   <= 9) BEGIN
          // updating pvrz index
          OUTER_SET pvrz_index = digit_ex*10000 + digit1000*1000 + digit100*100 + digit10*10 + digit1
          OUTER_SET new_pvrz_index = pvrz_index - original_base_index + new_base_index
          ACTION_IF (new_pvrz_index >= 0 && new_pvrz_index <= 99999) BEGIN
            ACTION_IF (new_pvrz_index >= 0 && new_pvrz_index < 10) BEGIN
              OUTER_TEXT_SPRINT new_file ~MOS000%new_pvrz_index%.PVRZ~
            END ELSE ACTION_IF (new_pvrz_index >= 10 && new_pvrz_index < 100) BEGIN
              OUTER_TEXT_SPRINT new_file ~MOS00%new_pvrz_index%.PVRZ~
            END ELSE ACTION_IF (new_pvrz_index >= 100 && new_pvrz_index < 1000) BEGIN
              OUTER_TEXT_SPRINT new_file ~MOS0%new_pvrz_index%.PVRZ~
            END ELSE BEGIN
              OUTER_TEXT_SPRINT new_file ~MOS%new_pvrz_index%.PVRZ~
            END
            COPY ~%source_file%~ ~%target_folder%/%new_file%~
            OUTER_SET success = 1
          END ELSE BEGIN
            WARN ~New PVRZ index is out of range. Skipping file.~
          END
        END ELSE BEGIN
          WARN ~Source filename does not match MOSxxxx.PVRZ. Skipping file.~
        END
      END ELSE BEGIN
        WARN ~Source filename does not match MOSxxxx.PVRZ. Skipping file.~
      END
    END ELSE BEGIN
      FAIL ~One or more required parameters are undefined.~
    END
  END
END


/**
 * This patch function attempts to find the first available free PVRZ index of a contiguous block
 * which guarantees to fit at least \"num_to_reserve\" indices.
 *
 * INT_VAR num_to_reserve   Find a contiguous block of at least this number of free indices
 *                          (range: [1..999], default: 1)
 * INT_VAR start_index      Index to start looking for (default: 1000)
 * RET free_index           Returns the first available index matching the specified parameters if successful
 *                          or -1 on error.
 */
DEFINE_PATCH_FUNCTION ~FIND_FREE_PVRZ_INDEX~
  INT_VAR
    num_to_reserve = 1
    start_index = 1000
  RET
    free_index
BEGIN
  SET free_index = \"-1\"
  PATCH_IF (ENGINE_IS ~bgee bg2ee iwdee pstee~) BEGIN
    PATCH_IF (num_to_reserve < 1) BEGIN
      SET num_to_reserve = 1
      PATCH_LOG ~Block size too small. Using default of 1.~
    END ELSE PATCH_IF (num_to_reserve > 999) BEGIN
      SET num_to_reserve = 999
      PATCH_LOG ~Block size too big. Truncating to 999.~
    END

    PATCH_IF (start_index < 0) BEGIN
      SET start_index = 0
      PATCH_LOG ~Start index too small. Setting start index to 0.~
    END ELSE PATCH_IF (start_index+num_to_reserve > 100000) BEGIN
      SET start_index = 100000 - num_to_reserve
      PATCH_LOG ~Start index too big. Setting start index to %start_index%.~
    END

    SET max_index = 100000 - num_to_reserve
    SET block_free = 0
    FOR (cur_idx = start_index; cur_idx <= max_index && block_free == 0; cur_idx += 1) BEGIN
      // checking for free index
      LPF ~a7#__is_free_pvrz~ INT_VAR index = cur_idx RET is_free_index END

      // checking for free block
      PATCH_IF (is_free_index != 0) BEGIN
        SET block_free = 1
        FOR (free_idx = cur_idx; free_idx < cur_idx+num_to_reserve && block_free != 0; free_idx += 1) BEGIN
          LPF ~a7#__is_free_pvrz~ INT_VAR index = free_idx RET is_free_index END
          PATCH_IF (is_free_index == 0) BEGIN
            SET block_free = 0
          END
        END
      END

      PATCH_IF (block_free) BEGIN
        SET free_index = cur_idx
      END
    END
  END
END


/**
 * This action function attempts to find the first available free PVRZ index of a contiguous block
 * which guarantees to fit at least \"num_to_reserve\" indices.
 *
 * INT_VAR num_to_reserve   Find a contiguous block of at least this number of free indices
 *                          (range: [1..999], default: 1)
 * INT_VAR start_index      Index to start looking for (default: 1000)
 * RET free_index           Returns the first available index matching the specified parameters if successful
 *                          or -1 on error.
 */
DEFINE_ACTION_FUNCTION ~FIND_FREE_PVRZ_INDEX~
  INT_VAR
    num_to_reserve = 1
    start_index = 1000
  RET
    free_index
BEGIN
  OUTER_PATCH ~foo~ BEGIN
    LPF ~FIND_FREE_PVRZ_INDEX~
      INT_VAR
        num_to_reserve
        start_index
      RET
        free_index
    END
  END
END


// Internally used. Determines the PVRZ index range used in the current resource.
DEFINE_PATCH_FUNCTION ~a7#__find_pvrz_index_range~
  INT_VAR
    num_blocks = \"-1\"
    ofs_blocks = \"-1\"
    block_size = 0x1c
  RET
    min_index
    max_index
BEGIN
  SET min_index = \"-1\"
  SET max_index = \"-1\"
  PATCH_IF (num_blocks > 0 && ofs_blocks >= 0 && block_size > 0) BEGIN
    SET min_index = 100000
    FOR (cur_block = 0; cur_block < num_blocks; cur_block += 1) BEGIN
      READ_SLONG (ofs_blocks + block_size*cur_block) pvrz_index
      PATCH_IF (pvrz_index >= 0 && pvrz_index <= 99999) BEGIN
        PATCH_IF (pvrz_index < min_index) BEGIN min_index = pvrz_index END
        PATCH_IF (pvrz_index > max_index) BEGIN max_index = pvrz_index END
      END
    END
    PATCH_IF (min_index == 100000 || max_index == \"-1\") BEGIN
      SET min_index = \"-1\"
      SET max_index = \"-1\"
    END
  END
END


// Internally used. Updates PVRZ indices in the current resource.
DEFINE_PATCH_FUNCTION ~a7#__update_pvrz_indices~
  INT_VAR
    num_blocks = \"-1\"
    ofs_blocks = \"-1\"
    block_size = 0x1c
    source_base_index = \"-1\"
    target_base_index = \"-1\"
  RET
    original_base_index
    new_base_index
BEGIN
  SET original_base_index = \"-1\"
  SET new_base_index = \"-1\"
  PATCH_IF (num_blocks > 0 && ofs_blocks >= 0 && block_size > 0 && source_base_index >= 0 && target_base_index >= 0) BEGIN
    PATCH_IF (source_base_index != target_base_index) BEGIN
      SET old_index = 100000
      SET new_index = 100000
      FOR (cur_block = 0; cur_block < num_blocks; cur_block += 1) BEGIN
        SET cur_ofs = ofs_blocks + block_size*cur_block
        READ_SLONG cur_ofs pvrz_index
        PATCH_IF (pvrz_index >= 0 && pvrz_index <= 99999) BEGIN
          SET new_pvrz_index = pvrz_index - source_base_index + target_base_index
          PATCH_IF (pvrz_index < old_index) BEGIN old_index = pvrz_index END
          PATCH_IF (new_pvrz_index < new_index) BEGIN new_index = new_pvrz_index END
          WRITE_LONG cur_ofs new_pvrz_index
        END
      END
      PATCH_IF (old_index != 100000 && new_index != 100000) BEGIN
        SET original_base_index = old_index
        SET new_base_index = new_index
      END
    END ELSE BEGIN
      SET original_base_index = source_base_index
      SET new_base_index = target_base_index
    END
  END
END


// Internally used. Determines whether the file MOSxxxx.PVRZ where xxxx = index is still unoccupied.
DEFINE_PATCH_FUNCTION ~a7#__is_free_pvrz~
  INT_VAR
    index = 0
  RET
    is_free_index
BEGIN
  PATCH_IF (index < 0) BEGIN
    SET index = 0
  END ELSE PATCH_IF (index > 99999) BEGIN
    SET index = 99999
  END

  PATCH_IF (index >= 0 && index < 10) BEGIN
    TEXT_SPRINT cur_file ~MOS000%index%.PVRZ~
  END ELSE PATCH_IF (index >= 10 && index < 100) BEGIN
    TEXT_SPRINT cur_file ~MOS00%index%.PVRZ~
  END ELSE PATCH_IF (index >= 100 && index < 1000) BEGIN
    TEXT_SPRINT cur_file ~MOS0%index%.PVRZ~
  END ELSE BEGIN
    TEXT_SPRINT cur_file ~MOS%index%.PVRZ~
  END

  SET is_free_index = (FILE_EXISTS_IN_GAME ~%cur_file%~ ||
                       FILE_EXISTS ~%USER_DIRECTORY%/override/%cur_file%~ ||
                       FILE_EXISTS ~lang/%EE_LANGUAGE%/override/%cur_file%~) ? 0 : 1
END
  ");
(".../WEIDU_NAMESPACE/cd_functions.tpa","/*
Author: CamDawg

v1: for iwd fixpack v2
v2: for iwd fixpack v3, bgee fixpack development
  fixed bug with unterminated WRITE_ASCII for item icons
v3: for bgee fixpack development
  consolidated ALTER_AREA_CONTAINER_trap, cd_container_icons into new ALTER_AREA_CONTAINER
  trapped and detected were writing to the wrong offsets in ALTER_AREA_REGION
v4: for bgee fixpack development
  fixed bug with patching duration_high on item headers in ALTER_ITEM_EFFECT
v5: for bgee fixpack development
  added support for primary, secondary schools for ALTER_ITEM_HEADER
v6: final touchups for WeiDU inclusion
  renamed macros to be more in line with IESDP/WeiDU conventions
  CONVERT_BG_IWD_DURATION now converts both directions
  ALTER_AREA_ENTRANCE, ALTER_AREA_REGION now compare the target with _CASE rather than _REGEXP
  the immunity fx batch stuff shouldn\'t have been included
  flag_backstab and flag_noinvisible support added for ALTER_ITEM_HEADER
v7: heavy-handed editing by Wisp
  all functions follow the naming convention ALTER_FOO_BAR instead of FOO_ALTER_BAR
  exclude CONVERT_BG_IWD_DURATION, because I think it is too niche
  rename a bunch of fields for increased clarity and consistency, real or imaginary
  ALTER_*_EFFECT cannot be used to alter number or index of extended effects
  condense pairs of item/spell functions to reduce repetition and retain the old functions as shell functions
v8: multi-platform coding
  functions now read version info from file and account for differences between various file formats
  between games, e.g. iwd2\'s area format and every game\'s different cre files.   

*/


/////                                                  \\\\\\\\\\
///// area functions                                   \\\\\\\\\\
/////                                                  \\\\\\\\\\

DEFINE_PATCH_FUNCTION ALTER_AREA_ENTRANCE
  INT_VAR x_coord = \"-1\"  // new x coordinate at 0x20; negative values mean no change
          y_coord = \"-1\"  // new y coordinate at 0x22; negative values mean no change
          orient  = \"-1\"  // new orientation at 0x24; negative values mean no change
  STR_VAR entrance_name = \"\" // required, needs to match ascii name at 0x00
BEGIN

  READ_ASCII 0x04 version (4)
  PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.1\" = 0) BEGIN // iwd2, are v9.1
    READ_LONG  0x78 ent_off
    READ_LONG  0x7c ent_num
  END ELSE BEGIN
    READ_LONG  0x68 ent_off
    READ_LONG  0x6c ent_num
  END
  FOR (index = 0 ; index < ent_num ; ++index) BEGIN
    READ_ASCII (ent_off + (index * 0x68)) ent_name (32) NULL
    PATCH_IF (\"%ent_name%\" STRING_COMPARE_CASE  \"%entrance_name%\" = 0) BEGIN
      PATCH_IF (x_coord >= 0) BEGIN WRITE_SHORT (ent_off + 0x20 + (index * 0x68)) x_coord END
      PATCH_IF (y_coord >= 0) BEGIN WRITE_SHORT (ent_off + 0x22 + (index * 0x68)) y_coord END
      PATCH_IF (orient >= 0)  BEGIN WRITE_LONG  (ent_off + 0x24 + (index * 0x68)) orient END
    END
  END

END

DEFINE_PATCH_FUNCTION ALTER_AREA_REGION
  INT_VAR type        = \"-1\" // region type at 0x20; negative values mean no change
          cursor      = \"-1\" // cursor type at 0x34; negative values mean no change
          trap_detect = \"-1\" // difficulty of trap detection at 0x68; negative values mean no change
          trap_remove = \"-1\" // difficulty of trap removal at 0x6a; negative values mean no change
          trapped     = \"-1\" // is trapped? at 0x6c; negative values mean no change
          detected    = \"-1\" // is detected? at 0x6e; negative values mean no change
          // flag_ vars affect flags starting at 0x60; 0 means remove flag, 1 means add flag, -1 no change
          flag_locked           = \"-1\" // locked, bit0
          flag_resets           = \"-1\" // trap resets, bit1
          flag_party_required   = \"-1\" // party required, bit2
          flag_trap_detectable  = \"-1\" // trap can be detected, bit3
          flag_trap_enemies     = \"-1\" // trap can be set off by enemies, bit4
          flag_tutorial         = \"-1\" // tutorial trigger, bit5
          flag_trap_npcs        = \"-1\" // trap can be set off by npcs, bit6
          flag_silent           = \"-1\" // silent trigger, bit7
          flag_deactivated      = \"-1\" // deactivated, bit8
          flag_impassable_npc   = \"-1\" // can not be passed by npcs, bit9
          flag_activation_point = \"-1\" // use activation point, bit10
          flag_connect_to_door  = \"-1\" // connected to door, bit11
          bounding_left         = \"-1\"
          bounding_top          = \"-1\"
          bounding_right        = \"-1\"
          bounding_bottom       = \"-1\"
          info_point            = 99999999
          launch_x              = \"-1\"
          launch_y              = \"-1\"
          activate_x            = \"-1\"
          activate_y            = \"-1\"
  STR_VAR region_name = \"\"     // required, at 0x00, used to match region
          destination_area    = \"same\" // changes destination area at 0x38; \"same\" means no change
          entrance_name     = \"same\" // changes entrance name at 0x40; \"same\" means no change
          door_key     = \"same\" // legacy
          door_script  = \"same\" // legacy
          region_key = EVAL \"%door_key%\" // resref of key to unlock at 0x74; \"same\" means no change
          region_script = EVAL\"%door_script%\" // resref of region script at 0x7c; \"same\" means no change
BEGIN


  READ_ASCII 0x04 version (4)
  PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.1\" = 0) BEGIN // iwd2, are v9.1
    READ_SHORT 0x6a trig_num
    READ_LONG  0x6c trig_off
  END ELSE BEGIN
    READ_SHORT 0x5a trig_num
    READ_LONG  0x5c trig_off
  END
  FOR (index = 0 ; index < trig_num ; ++index) BEGIN
    READ_ASCII (trig_off + (index * 0xc4)) trig_name_file (32) NULL
    PATCH_IF (\"%region_name%\" STRING_COMPARE_CASE  \"%trig_name_file%\" = 0) BEGIN
      PATCH_IF (type >= 0)                 BEGIN WRITE_SHORT (trig_off + 0x20 + (index * 0xc4)) type        END
      PATCH_IF (cursor >= 0)               BEGIN WRITE_LONG  (trig_off + 0x34 + (index * 0xc4)) cursor      END
      PATCH_IF (trap_detect >= 0)          BEGIN WRITE_SHORT (trig_off + 0x68 + (index * 0xc4)) trap_detect END
      PATCH_IF (trap_remove >= 0)          BEGIN WRITE_SHORT (trig_off + 0x6a + (index * 0xc4)) trap_remove END
      PATCH_IF (trapped >= 0)              BEGIN WRITE_SHORT (trig_off + 0x6c + (index * 0xc4)) trapped     END
      PATCH_IF (detected >= 0)             BEGIN WRITE_SHORT (trig_off + 0x6e + (index * 0xc4)) detected    END
      PATCH_IF (flag_locked = 0)           BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b11111110) END
      PATCH_IF (flag_resets = 0)           BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b11111101) END
      PATCH_IF (flag_party_required = 0)   BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b11111011) END
      PATCH_IF (flag_trap_detectable = 0)  BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b11110111) END
      PATCH_IF (flag_trap_enemies = 0)     BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b11101111) END
      PATCH_IF (flag_tutorial = 0)         BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b11011111) END
      PATCH_IF (flag_trap_npcs = 0)        BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b10111111) END
      PATCH_IF (flag_silent = 0)           BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BAND 0b01111111) END
      PATCH_IF (flag_deactivated = 0)      BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BAND 0b11111110) END
      PATCH_IF (flag_impassable_npc = 0)   BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BAND 0b11111101) END
      PATCH_IF (flag_activation_point = 0) BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BAND 0b11111011) END
      PATCH_IF (flag_connect_to_door = 0)  BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BAND 0b11110111) END
      PATCH_IF (flag_locked = 1)           BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT0) END
      PATCH_IF (flag_resets = 1)           BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT1) END
      PATCH_IF (flag_party_required = 1)   BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT2) END
      PATCH_IF (flag_trap_detectable = 1)  BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT3) END
      PATCH_IF (flag_trap_enemies = 1)     BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT4) END
      PATCH_IF (flag_tutorial = 1)         BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT5) END
      PATCH_IF (flag_trap_npcs = 1)        BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT6) END
      PATCH_IF (flag_silent = 1)           BEGIN WRITE_BYTE  (trig_off + 0x60 + (index * 0xc4)) (THIS BOR BIT7) END
      PATCH_IF (flag_deactivated = 1)      BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BOR BIT0) END
      PATCH_IF (flag_impassable_npc = 1)   BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BOR BIT1) END
      PATCH_IF (flag_activation_point = 1) BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BOR BIT2) END
      PATCH_IF (flag_connect_to_door = 1)  BEGIN WRITE_BYTE  (trig_off + 0x61 + (index * 0xc4)) (THIS BOR BIT3) END
      PATCH_IF (\"%destination_area%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (trig_off + 0x38 + (index * 0xc4)) \"%destination_area%\" #8
      END
      PATCH_IF (\"%entrance_name%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (trig_off + 0x40 + (index * 0xc4)) \"%entrance_name%\" #32
      END
      PATCH_IF (\"%region_key%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (trig_off + 0x74 + (index * 0xc4)) \"%region_key%\" #8
      END
      PATCH_IF (\"%region_script%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (trig_off + 0x7c + (index * 0xc4)) \"%region_script%\" #8
      END
      PATCH_IF (bounding_left >= 0)     BEGIN WRITE_SHORT (trig_off + 0x22 + (index * 0xc4)) bounding_left   END
      PATCH_IF (bounding_top >= 0)      BEGIN WRITE_SHORT (trig_off + 0x24 + (index * 0xc4)) bounding_top    END
      PATCH_IF (bounding_right >= 0)    BEGIN WRITE_SHORT (trig_off + 0x26 + (index * 0xc4)) bounding_right  END
      PATCH_IF (bounding_bottom >= 0)   BEGIN WRITE_SHORT (trig_off + 0x28 + (index * 0xc4)) bounding_bottom END
      PATCH_IF (info_point != 99999999) BEGIN WRITE_LONG  (trig_off + 0x64 + (index * 0xc4)) info_point      END
      PATCH_IF (launch_x >= 0)          BEGIN WRITE_SHORT (trig_off + 0x70 + (index * 0xc4)) launch_x        END
      PATCH_IF (launch_y >= 0)          BEGIN WRITE_SHORT (trig_off + 0x72 + (index * 0xc4)) launch_y        END
      PATCH_IF (activate_x >= 0)        BEGIN WRITE_SHORT (trig_off + 0x84 + (index * 0xc4)) activate_x      END
      PATCH_IF (activate_y >= 0)        BEGIN WRITE_SHORT (trig_off + 0x86 + (index * 0xc4)) activate_y      END
    END
  END

END

DEFINE_PATCH_FUNCTION ALTER_AREA_ACTOR
  INT_VAR x_coord = \"-1\" // new x coordinate at 0x20 and 0x24; negative values mean no change
          y_coord = \"-1\" // new y coordinate at 0x22 and 0x26; negative values mean no change
          orient  = \"-1\" // facing direction for actor at 0x34; negative values mean no change
          dest_x       = \"-1\"
          dest_y       = \"-1\"
          spawned      = \"-1\"
          animation    = \"-1\"
          expiry       = \"-2\"
          wander       = \"-1\"
          follow       = \"-1\"
          times_talked = \"-1\"
          flag_cre_unattached = \"-1\"
          flag_seen_party     = \"-1\"
          flag_invulnerable   = \"-1\"
          flag_override_script_name   = \"-1\"
          flag_time_0         = \"-1\"
          flag_time_1         = \"-1\"
          flag_time_2         = \"-1\"
          flag_time_3         = \"-1\"
          flag_time_4         = \"-1\"
          flag_time_5         = \"-1\"
          flag_time_6         = \"-1\"
          flag_time_7         = \"-1\"
          flag_time_8         = \"-1\"
          flag_time_9         = \"-1\"
          flag_time_10        = \"-1\"
          flag_time_11        = \"-1\"
          flag_time_12        = \"-1\"
          flag_time_13        = \"-1\"
          flag_time_14        = \"-1\"
          flag_time_15        = \"-1\"
          flag_time_16        = \"-1\"
          flag_time_17        = \"-1\"
          flag_time_18        = \"-1\"
          flag_time_19        = \"-1\"
          flag_time_20        = \"-1\"
          flag_time_21        = \"-1\"
          flag_time_22        = \"-1\"
          flag_time_23        = \"-1\"

  STR_VAR actor_name       = \"\"     // required, at 0x00, used to match actor
          dlg_file         = \"same\" // changes dialog file at 0x48; \"same\" means no change
          script_override  = \"same\" // changes override script at 0x50; \"same\" means no change
          script_general   = \"same\" // changes general script at 0x58; \"same\" means no change
          script_class     = \"same\" // changes class script at 0x60; \"same\" means no change
          script_race      = \"same\" // changes race script at 0x68; \"same\" means no change
          script_default   = \"same\" // changes default script at 0x70; \"same\" means no change
          script_specifics = \"same\" // changes specifics script at 0x78; \"same\" means no change
          cre_file         = \"same\" // changes creature file at 0x80; \"same\" means no change
BEGIN

  READ_ASCII 0x04 version (4)
  PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.1\" = 0) BEGIN // iwd2, are v9.1
    READ_LONG  0x64 cre_off
    READ_SHORT 0x68 cre_num
  END ELSE BEGIN
    READ_LONG  0x54 cre_off
    READ_SHORT 0x58 cre_num
  END
  FOR (index = 0 ; index < cre_num ; ++index) BEGIN
    READ_ASCII (cre_off + (index * 0x110)) actor_name_file (32) NULL
    PATCH_IF (\"%actor_name%\" STRING_COMPARE_CASE \"%actor_name_file%\" = 0) BEGIN
      PATCH_IF (x_coord >= 0) BEGIN
        WRITE_SHORT (cre_off + 0x20 + (index * 0x110)) x_coord
        PATCH_IF (dest_x < 0) BEGIN
          WRITE_SHORT (cre_off + 0x24 + (index * 0x110)) x_coord
        END
      END
      PATCH_IF (y_coord >= 0) BEGIN
        WRITE_SHORT (cre_off + 0x22 + (index * 0x110)) y_coord
        PATCH_IF (dest_y < 0) BEGIN
          WRITE_SHORT (cre_off + 0x26 + (index * 0x110)) y_coord
        END
      END
      PATCH_IF (orient >= 0)  BEGIN WRITE_SHORT (cre_off + 0x34 + (index * 0x110)) orient END
      PATCH_IF (\"%dlg_file%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x48 + (index * 0x110)) \"%dlg_file%\" #8
      END
      PATCH_IF (\"%script_override%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x50 + (index * 0x110)) \"%script_override%\" #8
      END
      PATCH_IF (\"%script_general%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x58 + (index * 0x110)) \"%script_general%\" #8
      END
      PATCH_IF (\"%script_race%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x68 + (index * 0x110)) \"%script_race%\" #8
      END
      PATCH_IF (\"%script_default%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x70 + (index * 0x110)) \"%script_default%\" #8
      END
      PATCH_IF (\"%script_class%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x60 + (index * 0x110)) \"%script_class%\" #8
      END
      PATCH_IF (\"%script_specifics%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x78 + (index * 0x110)) \"%script_specifics%\" #8
      END
      PATCH_IF (\"%cre_file%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cre_off + 0x80 + (index * 0x110)) \"%cre_file%\" #8
      END
      PATCH_IF (dest_x >= 0)       BEGIN WRITE_SHORT (cre_off + 0x24 + (index * 0x110)) dest_x       END
      PATCH_IF (dest_y >= 0)       BEGIN WRITE_SHORT (cre_off + 0x26 + (index * 0x110)) dest_y       END
      PATCH_IF (spawned >= 0)      BEGIN WRITE_SHORT (cre_off + 0x2c + (index * 0x110)) spawned      END
      PATCH_IF (animation >= 0)    BEGIN WRITE_LONG  (cre_off + 0x30 + (index * 0x110)) animation    END
      PATCH_IF (expiry >= \"-1\")    BEGIN WRITE_LONG  (cre_off + 0x38 + (index * 0x110)) expiry       END
      PATCH_IF (wander >= 0)       BEGIN WRITE_SHORT (cre_off + 0x3c + (index * 0x110)) wander       END
      PATCH_IF (follow >= 0)       BEGIN WRITE_SHORT (cre_off + 0x3e + (index * 0x110)) follow       END
      PATCH_IF (times_talked >= 0) BEGIN WRITE_LONG  (cre_off + 0x44 + (index * 0x110)) times_talked END
      PATCH_IF (flag_cre_unattached = 0) BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS & `BIT0) END
      PATCH_IF (flag_cre_unattached = 1) BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS BOR BIT0) END
      PATCH_IF (flag_seen_party = 0)     BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS & `BIT1) END
      PATCH_IF (flag_seen_party = 1)     BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS BOR BIT1) END
      PATCH_IF (flag_invulnerable = 0)         BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS & `BIT2) END
      PATCH_IF (flag_invulnerable = 1)         BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS BOR BIT2) END
      PATCH_IF (flag_override_script_name = 0)    BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS & `BIT3) END
      PATCH_IF (flag_override_script_name = 1)    BEGIN WRITE_BYTE  (cre_off + 0x28 + (index * 0x110)) (THIS BOR BIT3) END
      PATCH_IF (flag_time_0 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT0) END
      PATCH_IF (flag_time_0 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT0) END
      PATCH_IF (flag_time_1 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT1) END
      PATCH_IF (flag_time_1 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT1) END
      PATCH_IF (flag_time_2 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT2) END
      PATCH_IF (flag_time_2 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT2) END
      PATCH_IF (flag_time_3 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT3) END
      PATCH_IF (flag_time_3 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT3) END
      PATCH_IF (flag_time_4 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT4) END
      PATCH_IF (flag_time_4 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT4) END
      PATCH_IF (flag_time_5 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT5) END
      PATCH_IF (flag_time_5 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT5) END
      PATCH_IF (flag_time_6 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT6) END
      PATCH_IF (flag_time_6 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT6) END
      PATCH_IF (flag_time_7 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS & `BIT7) END
      PATCH_IF (flag_time_7 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x40 + (index * 0x110)) (THIS BOR BIT7) END
      PATCH_IF (flag_time_8 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT0) END
      PATCH_IF (flag_time_8 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT0) END
      PATCH_IF (flag_time_9 = 0)  BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT1) END
      PATCH_IF (flag_time_9 = 1)  BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT1) END
      PATCH_IF (flag_time_10 = 0) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT2) END
      PATCH_IF (flag_time_10 = 1) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT2) END
      PATCH_IF (flag_time_11 = 0) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT3) END
      PATCH_IF (flag_time_11 = 1) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT3) END
      PATCH_IF (flag_time_12 = 0) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT4) END
      PATCH_IF (flag_time_12 = 1) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT4) END
      PATCH_IF (flag_time_13 = 0) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT5) END
      PATCH_IF (flag_time_13 = 1) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT5) END
      PATCH_IF (flag_time_14 = 0) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT6) END
      PATCH_IF (flag_time_14 = 1) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT6) END
      PATCH_IF (flag_time_15 = 0) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS & `BIT7) END
      PATCH_IF (flag_time_15 = 1) BEGIN WRITE_BYTE  (cre_off + 0x41 + (index * 0x110)) (THIS BOR BIT7) END
      PATCH_IF (flag_time_16 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT0) END
      PATCH_IF (flag_time_16 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT0) END
      PATCH_IF (flag_time_17 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT1) END
      PATCH_IF (flag_time_17 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT1) END
      PATCH_IF (flag_time_18 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT2) END
      PATCH_IF (flag_time_18 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT2) END
      PATCH_IF (flag_time_19 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT3) END
      PATCH_IF (flag_time_19 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT3) END
      PATCH_IF (flag_time_20 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT4) END
      PATCH_IF (flag_time_20 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT4) END
      PATCH_IF (flag_time_21 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT5) END
      PATCH_IF (flag_time_21 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT5) END
      PATCH_IF (flag_time_22 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT6) END
      PATCH_IF (flag_time_22 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT6) END
      PATCH_IF (flag_time_23 = 0) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS & `BIT7) END
      PATCH_IF (flag_time_23 = 1) BEGIN WRITE_BYTE  (cre_off + 0x42 + (index * 0x110)) (THIS BOR BIT7) END
    END
  END

END

DEFINE_PATCH_FUNCTION ALTER_AREA_CONTAINER
  INT_VAR container_type  = \"-1\" // container type; icon displayed when opened at 0x24; negative values mean no change
          trapped         = \"-1\" // is trapped? at 0x30; negative values mean no change
          detected        = \"-1\" // is detected? at 0x32; negative values mean no change
          lockpick_strref = \"-1\" // lockpick string at 0x84; negative values mean no change
          lock_difficulty = \"-1\" // difficulty to pick lock at 0x26; negative values mean no change
          trap_detect     = \"-1\" // difficulty to detect trap at 0x2c; negative values mean no change
          trap_remove     = \"-1\" // difficulty to remove tap at 0x2e; negative values mean no change
          // flag_ vars affect flags starting at 0x28; 0 means remove flag, 1 means add flag, -1 no change
          flag_locked     = \"-1\" // locked, bit0
          flag_mlocked    = \"-1\" // magical lock, bit2
          flag_resets     = \"-1\" // trap resets, bit3
          flag_disabled   = \"-1\" // disabled, bit5
          coord_x         = \"-1\"
          coord_y         = \"-1\"
          launch_x        = \"-1\"
          launch_y        = \"-1\"
          bounding_left   = \"-1\"
          bounding_top    = \"-1\"
          bounding_right  = \"-1\"
          bounding_bottom = \"-1\"
          range           = \"-1\"
  STR_VAR container_name  = \"\"   // required, at 0x00, used to match container
          container_script = \"same\" // changes container script at 0x48; \"same\" means no change
          container_key    = \"same\" // changes container key 0x78; \"same\" means no change
BEGIN

  READ_ASCII 0x04 version (4)
  PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.1\" = 0) BEGIN // iwd2, are v9.1
    READ_LONG  0x80 cont_off
    READ_SHORT 0x84 cont_num
  END ELSE BEGIN
    READ_LONG  0x70 cont_off
    READ_SHORT 0x74 cont_num
  END
  FOR (index = 0 ; index < cont_num ; ++index) BEGIN
    READ_ASCII (cont_off + (index * 0xc0)) cont_name_file (32) NULL
    PATCH_IF (\"%container_name%\" STRING_COMPARE_CASE \"%cont_name_file%\" = 0) BEGIN
      PATCH_IF (container_type  >= 0) BEGIN WRITE_SHORT (cont_off + 0x24 + (index * 0xc0)) container_type  END
      PATCH_IF (lock_difficulty >= 0) BEGIN WRITE_SHORT (cont_off + 0x26 + (index * 0xc0)) lock_difficulty END
      PATCH_IF (trap_detect     >= 0) BEGIN WRITE_SHORT (cont_off + 0x2c + (index * 0xc0)) trap_detect     END
      PATCH_IF (trap_remove     >= 0) BEGIN WRITE_SHORT (cont_off + 0x2e + (index * 0xc0)) trap_remove     END
      PATCH_IF (trapped         >= 0) BEGIN WRITE_SHORT (cont_off + 0x30 + (index * 0xc0)) trapped         END
      PATCH_IF (detected        >= 0) BEGIN WRITE_SHORT (cont_off + 0x32 + (index * 0xc0)) detected        END
      PATCH_IF (lockpick_strref >= 0) BEGIN WRITE_LONG  (cont_off + 0x84 + (index * 0xc0)) lockpick_strref END

      PATCH_IF (flag_locked   = 0) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS & `BIT0 END
      PATCH_IF (flag_mlocked  = 0) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS & `BIT2 END
      PATCH_IF (flag_resets   = 0) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS & `BIT3 END
      PATCH_IF (flag_disabled = 0) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS & `BIT5 END
      PATCH_IF (flag_locked   = 1) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS | BIT0  END
      PATCH_IF (flag_mlocked  = 1) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS | BIT2  END
      PATCH_IF (flag_resets   = 1) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS | BIT3  END
      PATCH_IF (flag_disabled = 1) BEGIN WRITE_BYTE  (cont_off + 0x28 + (index * 0xc0)) THIS | BIT5  END

      PATCH_IF (\"%container_script%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cont_off + 0x48 + (index * 0xc0)) \"%container_script%\" #8
      END
      PATCH_IF (\"%container_key%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (cont_off + 0x78 + (index * 0xc0)) \"%container_key%\" #8
      END

      PATCH_IF (coord_x  >= 0)                BEGIN WRITE_SHORT (cont_off + 0x20 + (index * 0xc0)) coord_x         END
      PATCH_IF (coord_y  >= 0)                BEGIN WRITE_SHORT (cont_off + 0x22 + (index * 0xc0)) coord_y         END
      PATCH_IF (launch_x  >= 0)               BEGIN WRITE_SHORT (cont_off + 0x34 + (index * 0xc0)) launch_x        END
      PATCH_IF (launch_y  >= 0)               BEGIN WRITE_SHORT (cont_off + 0x36 + (index * 0xc0)) launch_y        END
      PATCH_IF (bounding_left  >= 0)          BEGIN WRITE_SHORT (cont_off + 0x38 + (index * 0xc0)) bounding_left   END
      PATCH_IF (bounding_top  >= 0)           BEGIN WRITE_SHORT (cont_off + 0x3a + (index * 0xc0)) bounding_top    END
      PATCH_IF (bounding_right  >= 0)         BEGIN WRITE_SHORT (cont_off + 0x3c + (index * 0xc0)) bounding_right  END
      PATCH_IF (bounding_bottom  >= 0)        BEGIN WRITE_SHORT (cont_off + 0x3e + (index * 0xc0)) bounding_bottom END
      PATCH_IF (range  >= 0)                  BEGIN WRITE_SHORT (cont_off + 0x56 + (index * 0xc0)) range           END
    END
  END

END

DEFINE_PATCH_FUNCTION ALTER_AREA_DOOR
  INT_VAR cursor          = \"-1\" // changes cursor at 0x68; negative values mean no change
          trap_detect     = \"-1\" // difficulty of trap detection at 0x6c; negative values mean no change
          trap_remove     = \"-1\" // difficulty of trap removal at 0x6e; negative values mean no change
          trapped         = \"-1\" // is trapped? at 0x70; negative values mean no change
          detected        = \"-1\" // is detected? at 0x72; negative values mean no change
          door_detect     = \"-1\" // difficulty of detection at 0x88; negative values mean no change
          lock_difficulty = \"-1\" // difficulty of lock at 0x8c; negative values mean no change
          flag_open         = \"-1\"
          flag_locked       = \"-1\"
          flag_resets       = \"-1\"
          flag_detectable   = \"-1\"
          flag_forced       = \"-1\"
          flag_no_close     = \"-1\"
          flag_located      = \"-1\"
          flag_secret       = \"-1\"
          flag_detected     = \"-1\"
          flag_no_look      = \"-1\"
          flag_uses_key     = \"-1\"
          flag_sliding      = \"-1\"
          bounding_open_left   = \"-1\"
          bounding_open_top    = \"-1\"
          bounding_open_right  = \"-1\"
          bounding_open_bottom = \"-1\"
          bounding_closed_left   = \"-1\"
          bounding_closed_top    = \"-1\"
          bounding_closed_right  = \"-1\"
          bounding_closed_bottom = \"-1\"
          door_hp           = \"-1\"
          door_ac           = \"-1\"
          launch_x          = \"-1\"
          launch_y          = \"-1\"
          open_x            = \"-1\"
          open_y            = \"-1\"
          close_x           = \"-1\"
          close_y           = \"-1\"
          string_unlock     = 99999999
          string_speaker    = 99999999

  STR_VAR door_name   = \"\"     // required, at 0x00, used to match door
          door_key    = \"same\" // changes door key at 0x78; \"same\" means no change
          door_script = \"same\" // changes door script at 0x80; \"same\" means no change; \"same\" means no change
          door_open_sound  = \"same\"
          door_close_sound = \"same\"
          travel_trigger = \"same\"
          dialogue       = \"same\"
BEGIN

  READ_ASCII 0x04 version (4)
  PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.1\" = 0) BEGIN // iwd2, are v9.1
    READ_LONG 0xb4 door_num
    READ_LONG 0xb8 door_off
  END ELSE BEGIN
    READ_LONG 0xa4 door_num
    READ_LONG 0xa8 door_off
  END
  FOR (index = 0 ; index < door_num ; ++index) BEGIN
    READ_ASCII (door_off + (index * 0xc8)) door_name_file (32) NULL
    PATCH_IF (\"%door_name%\" STRING_COMPARE_CASE \"%door_name_file%\" = 0) BEGIN
      PATCH_IF (cursor          >= 0) BEGIN WRITE_LONG  (door_off + 0x68 + (index * 0xc8)) cursor          END
      PATCH_IF (trap_detect     >= 0) BEGIN WRITE_SHORT (door_off + 0x6c + (index * 0xc8)) trap_detect     END
      PATCH_IF (trap_remove     >= 0) BEGIN WRITE_SHORT (door_off + 0x6e + (index * 0xc8)) trap_remove     END
      PATCH_IF (trapped         >= 0) BEGIN WRITE_SHORT (door_off + 0x70 + (index * 0xc8)) trapped         END
      PATCH_IF (detected        >= 0) BEGIN WRITE_SHORT (door_off + 0x72 + (index * 0xc8)) detected        END
      PATCH_IF (door_detect     >= 0) BEGIN WRITE_LONG  (door_off + 0x88 + (index * 0xc8)) door_detect     END
      PATCH_IF (lock_difficulty >= 0) BEGIN WRITE_LONG  (door_off + 0x8c + (index * 0xc8)) lock_difficulty END

      PATCH_IF (\"%door_key%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (door_off + 0x78 + (index * 0xc8)) \"%door_key%\" #8
      END
      PATCH_IF (\"%door_script%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (door_off + 0x80 + (index * 0xc8)) \"%door_script%\" #8
      END

      PATCH_IF (flag_open       = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT0 END
      PATCH_IF (flag_open       = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT0 END
      PATCH_IF (flag_locked     = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT1 END
      PATCH_IF (flag_locked     = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT1 END
      PATCH_IF (flag_resets     = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT2 END
      PATCH_IF (flag_resets     = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT2 END
      PATCH_IF (flag_detectable = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT3 END
      PATCH_IF (flag_detectable = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT3 END
      PATCH_IF (flag_forced     = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT4 END
      PATCH_IF (flag_forced     = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT4 END
      PATCH_IF (flag_no_close   = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT5 END
      PATCH_IF (flag_no_close   = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT5 END
      PATCH_IF (flag_located    = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT6 END
      PATCH_IF (flag_located    = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT6 END
      PATCH_IF (flag_secret     = 0) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS & `BIT7 END
      PATCH_IF (flag_secret     = 1) BEGIN WRITE_BYTE  (door_off + 0x28 + (index * 0xc8)) THIS |  BIT7 END
      PATCH_IF (flag_detected   = 0) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS & `BIT0 END
      PATCH_IF (flag_detected   = 1) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS |  BIT0 END
      PATCH_IF (flag_no_look    = 0) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS & `BIT1 END
      PATCH_IF (flag_no_look    = 1) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS |  BIT1 END
      PATCH_IF (flag_uses_key   = 0) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS & `BIT2 END
      PATCH_IF (flag_uses_key   = 1) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS |  BIT2 END
      PATCH_IF (flag_sliding    = 0) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS & `BIT3 END
      PATCH_IF (flag_sliding    = 1) BEGIN WRITE_BYTE  (door_off + 0x29 + (index * 0xc8)) THIS |  BIT3 END

      PATCH_IF (bounding_open_left       >= 0) BEGIN WRITE_SHORT (door_off + 0x38 + (index * 0xc8)) bounding_open_left   END
      PATCH_IF (bounding_open_top        >= 0) BEGIN WRITE_SHORT (door_off + 0x3a + (index * 0xc8)) bounding_open_top    END
      PATCH_IF (bounding_open_right      >= 0) BEGIN WRITE_SHORT (door_off + 0x3c + (index * 0xc8)) bounding_open_right  END
      PATCH_IF (bounding_open_bottom     >= 0) BEGIN WRITE_SHORT (door_off + 0x3e + (index * 0xc8)) bounding_open_bottom END
      PATCH_IF (bounding_closed_left       >= 0) BEGIN WRITE_SHORT (door_off + 0x40 + (index * 0xc8)) bounding_closed_left   END
      PATCH_IF (bounding_closed_top        >= 0) BEGIN WRITE_SHORT (door_off + 0x42 + (index * 0xc8)) bounding_closed_top    END
      PATCH_IF (bounding_closed_right      >= 0) BEGIN WRITE_SHORT (door_off + 0x44 + (index * 0xc8)) bounding_closed_right  END
      PATCH_IF (bounding_closed_bottom     >= 0) BEGIN WRITE_SHORT (door_off + 0x46 + (index * 0xc8)) bounding_closed_bottom END
      PATCH_IF (door_hp               >= 0) BEGIN WRITE_SHORT (door_off + 0x54 + (index * 0xc8)) door_hp           END
      PATCH_IF (door_ac               >= 0) BEGIN WRITE_SHORT (door_off + 0x56 + (index * 0xc8)) door_ac           END
      PATCH_IF (launch_x              >= 0) BEGIN WRITE_SHORT (door_off + 0x74 + (index * 0xc8)) launch_x          END
      PATCH_IF (launch_y              >= 0) BEGIN WRITE_SHORT (door_off + 0x76 + (index * 0xc8)) launch_y          END
      PATCH_IF (open_x                >= 0) BEGIN WRITE_SHORT (door_off + 0x90 + (index * 0xc8)) open_x            END
      PATCH_IF (open_y                >= 0) BEGIN WRITE_SHORT (door_off + 0x92 + (index * 0xc8)) open_y            END
      PATCH_IF (close_x               >= 0) BEGIN WRITE_SHORT (door_off + 0x94 + (index * 0xc8)) close_x           END
      PATCH_IF (close_y               >= 0) BEGIN WRITE_SHORT (door_off + 0x96 + (index * 0xc8)) close_y           END
      PATCH_IF (string_unlock  != 99999999) BEGIN WRITE_LONG  (door_off + 0x98 + (index * 0xc8)) string_unlock     END
      PATCH_IF (string_speaker != 99999999) BEGIN WRITE_LONG  (door_off + 0xb4 + (index * 0xc8)) string_speaker    END

      PATCH_IF (\"%door_open_sound%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (door_off + 0x58 + (index * 0xc8)) \"%door_open_sound%\" #8
      END
      PATCH_IF (\"%door_close_sound%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (door_off + 0x60 + (index * 0xc8)) \"%door_close_sound%\" #8
      END
      PATCH_IF (\"%travel_trigger%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (door_off + 0x9c + (index * 0xc8)) \"%travel_trigger%\" #24
      END
      PATCH_IF (\"%dialogue%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (door_off + 0xb8 + (index * 0xc8)) \"%dialogue%\" #8
      END
    END
  END

END

/////                                                  \\\\\\\\\\
///// item/spell functions                             \\\\\\\\\\
/////                                                  \\\\\\\\\\

DEFINE_PATCH_FUNCTION ALTER_ITMSPL_EFFECT
  INT_VAR
    check_globals  = 0      // check global effects: 0 for no, 1 for yes
    check_headers  = 0      // check effects on headers; 0 for no, 1 for yes
    header         = 0      // add to this header; 0 for all headers
    header_type    = \"-1\"   // -1 to check all headers, otherwise use type specified
    match_opcode   = \"-1\"   // opcode at 0x00 to match, use -1 for all
    new_opcode     = \"-1\"   // if opcode matches, change to this value
    target         = \"-1\"   // change target at 0x02; negative values mean no change
    timing         = \"-1\"   // change timing at 0x0c; negative values mean no change
    power          = \"-1\"   // change power level at 0x03; negative values mean no change
    parameter1     = \"-1\"   // change parameter at 0x04; negative values mean no change
    parameter2     = \"-1\"   // change parameter at 0x08; negative values mean no change
    resist_dispel  = \"-1\"   // change resist/dispel at 0x0d; negative values mean no change
    duration       = \"-1\"   // change duration at 0x0e; negative values mean no change
    duration_high  = \"-1\"   // same as duration, but only if existing duration > 5
    probability1   = \"-1\"   // change high probability at 0x12; negative values mean no change
    probability2   = \"-1\"   // change low probability at 0x13; negative values mean no change
    dicenumber     = \"-1\"   // change number of dice at 0x1c; negative values mean no change
    dicesize       = \"-1\"   // change size of dice at 0x20; negative values mean no change
    savingthrow    = \"-1\"   // changing type of saving throw at 0x24; negative values mean no change
    savebonus      = \"-11\"  // change save bonus/penalty; values -11 or lower are ignored
    special        = \"-1\"   // change special; negative values mean no change
    header_length = 0x38
  STR_VAR
    resource       = \"same\" // resref at 0x14; same means no change, otherwise use this value
BEGIN

  READ_LONG 0x6a fx_off
  PATCH_IF (check_globals = 1) BEGIN
    READ_SHORT 0x70 fx_num
    FOR (index = 0 ; index < fx_num ; ++index) BEGIN
      READ_SHORT (fx_off +        (index * 0x30)) opcode_file
      PATCH_IF ((match_opcode = opcode_file) OR (match_opcode < 0)) BEGIN
        PATCH_IF (new_opcode >= 0)    BEGIN WRITE_SHORT (fx_off +        (index * 0x30)) new_opcode    END
        PATCH_IF (target >= 0)        BEGIN WRITE_BYTE  (fx_off + 0x02 + (index * 0x30)) target        END
        PATCH_IF (power >= 0)         BEGIN WRITE_BYTE  (fx_off + 0x03 + (index * 0x30)) power         END
        PATCH_IF (parameter1 >= 0)    BEGIN WRITE_LONG  (fx_off + 0x04 + (index * 0x30)) parameter1    END
        PATCH_IF (parameter2 >= 0)    BEGIN WRITE_LONG  (fx_off + 0x08 + (index * 0x30)) parameter2    END
        PATCH_IF (timing >= 0)        BEGIN WRITE_BYTE  (fx_off + 0x0c + (index * 0x30)) timing        END
        PATCH_IF (resist_dispel >= 0) BEGIN WRITE_BYTE  (fx_off + 0x0d + (index * 0x30)) resist_dispel END
        PATCH_IF (duration >= 0)      BEGIN WRITE_LONG  (fx_off + 0x0e + (index * 0x30)) duration      END
        PATCH_IF (probability1 >= 0)  BEGIN WRITE_BYTE  (fx_off + 0x12 + (index * 0x30)) probability1  END
        PATCH_IF (probability2 >= 0)  BEGIN WRITE_BYTE  (fx_off + 0x13 + (index * 0x30)) probability2  END
        PATCH_IF (dicenumber >= 0)    BEGIN WRITE_LONG  (fx_off + 0x1c + (index * 0x30)) dicenumber    END
        PATCH_IF (dicesize >= 0)      BEGIN WRITE_LONG  (fx_off + 0x20 + (index * 0x30)) dicesize      END
        PATCH_IF (savingthrow >= 0)   BEGIN WRITE_LONG  (fx_off + 0x24 + (index * 0x30)) savingthrow   END
        PATCH_IF (savebonus >= \"-10\") BEGIN WRITE_LONG  (fx_off + 0x28 + (index * 0x30)) savebonus     END
        PATCH_IF (special >= 0)       BEGIN WRITE_LONG  (fx_off + 0x2c + (index * 0x30)) special       END
        PATCH_IF (duration_high >= 0) BEGIN
          READ_LONG (fx_off + 0x0e + (index * 0x30)) duration_file
          PATCH_IF (duration_file > 5) BEGIN
            WRITE_LONG (fx_off + 0x0e + (index * 0x30)) duration_high
          END
        END
        PATCH_IF (\"%resource%\" STRING_COMPARE_CASE \"same\") BEGIN
          WRITE_ASCIIE (fx_off + 0x14 + (index * 0x30)) \"%resource%\" #8
        END
      END
    END
  END
  PATCH_IF (check_headers = 1) BEGIN
    READ_LONG   0x64 \"abil_off\"
    READ_SHORT  0x68 \"abil_num\"
    PATCH_IF (header = 0) BEGIN SET loop_start = 0            SET loop_end = abil_num END
                     ELSE BEGIN SET loop_start = (header - 1) SET loop_end = header   END
    FOR (index2 = loop_start ; index2 < loop_end ; ++index2) BEGIN // looks through headers
      READ_BYTE (abil_off +        (index2 * header_length)) abil_type
      PATCH_IF ((abil_type = header_type) OR (header_type < 0)) BEGIN
        READ_SHORT (abil_off + 0x1e + (index2 * header_length)) abil_fx_num
        READ_SHORT (abil_off + 0x20 + (index2 * header_length)) abil_fx_idx
        FOR (index = 0 ; index < abil_fx_num ; index = index + 1) BEGIN
          READ_SHORT (fx_off +        ((abil_fx_idx + index) * 0x30)) opcode_file
          PATCH_IF ((match_opcode = opcode_file) OR (match_opcode < 0)) BEGIN
            PATCH_IF (new_opcode >= 0)    BEGIN WRITE_SHORT (fx_off +        ((index + abil_fx_idx) * 0x30)) new_opcode    END
            PATCH_IF (target >= 0)        BEGIN WRITE_BYTE  (fx_off + 0x02 + ((index + abil_fx_idx) * 0x30)) target        END
            PATCH_IF (power >= 0)         BEGIN WRITE_BYTE  (fx_off + 0x03 + ((index + abil_fx_idx) * 0x30)) power         END
            PATCH_IF (parameter1 >= 0)    BEGIN WRITE_LONG  (fx_off + 0x04 + ((index + abil_fx_idx) * 0x30)) parameter1    END
            PATCH_IF (parameter2 >= 0)    BEGIN WRITE_LONG  (fx_off + 0x08 + ((index + abil_fx_idx) * 0x30)) parameter2    END
            PATCH_IF (timing >= 0)        BEGIN WRITE_BYTE  (fx_off + 0x0c + ((index + abil_fx_idx) * 0x30)) timing        END
            PATCH_IF (resist_dispel >= 0) BEGIN WRITE_BYTE  (fx_off + 0x0d + ((index + abil_fx_idx) * 0x30)) resist_dispel END
            PATCH_IF (duration >= 0)      BEGIN WRITE_LONG  (fx_off + 0x0e + ((index + abil_fx_idx) * 0x30)) duration      END
            PATCH_IF (probability1 >= 0)  BEGIN WRITE_BYTE  (fx_off + 0x12 + ((index + abil_fx_idx) * 0x30)) probability1  END
            PATCH_IF (probability2 >= 0)  BEGIN WRITE_BYTE  (fx_off + 0x13 + ((index + abil_fx_idx) * 0x30)) probability2  END
            PATCH_IF (dicenumber >= 0)    BEGIN WRITE_LONG  (fx_off + 0x1c + ((index + abil_fx_idx) * 0x30)) dicenumber    END
            PATCH_IF (dicesize >= 0)      BEGIN WRITE_LONG  (fx_off + 0x20 + ((index + abil_fx_idx) * 0x30)) dicesize      END
            PATCH_IF (savingthrow >= 0)   BEGIN WRITE_LONG  (fx_off + 0x24 + ((index + abil_fx_idx) * 0x30)) savingthrow   END
            PATCH_IF (savebonus >= \"-10\") BEGIN WRITE_LONG  (fx_off + 0x28 + ((index + abil_fx_idx) * 0x30)) savebonus     END
            PATCH_IF (special >= 0)       BEGIN WRITE_LONG  (fx_off + 0x2c + ((index + abil_fx_idx) * 0x30)) special       END
            PATCH_IF (duration_high >= 0) BEGIN
              READ_LONG (fx_off + 0x0e + ((index + abil_fx_idx) * 0x30)) duration_file
              PATCH_IF (duration_file > 5) BEGIN
                WRITE_LONG (fx_off + 0x0e + ((index + abil_fx_idx) * 0x30)) duration_high
              END
            END
            PATCH_IF (\"%resource%\" STRING_COMPARE_CASE \"same\") BEGIN
              WRITE_ASCIIE (fx_off + 0x14 + ((index + abil_fx_idx) * 0x30)) \"%resource%\" #8
            END
          END
        END
      END
    END
  END

END

DEFINE_PATCH_FUNCTION ALTER_ITMSPL_HEADER
  INT_VAR
    header_type        = \"-1\" // -1 is all headers, otherwise use value here
    match_icon         = 0    // make icon match a qualifier, 0 = no, 1 = yes
    header             = 0    // 0 matches all headers, otherwise just modify specified header - use with type = -1
    new_header_type    = \"-1\" // change the type at 0x00 to this value; negative values mean no change
    identify           = \"-1\" // identify to use? at 0x01; negative values mean no change
    location           = \"-1\" // ability location at 0x02; negative values mean no change
    target             = \"-1\" // target at 0x0c; negative values mean no change
    target_count       = \"-1\" // target count at 0x0d; negative values mean no change
    range              = \"-1\" // range at 0x0e; negative values mean no change
    launcher_or_level  = \"-1\" // launcher (item) or min level (spell) required at 0x10; negative values mean no change
    speed              = \"-1\" // speed at 0x12; negative values mean no change
    thac0_bonus        = \"-1\" // to-hit bonus at 0x14; negative values mean no change
    dicesize           = \"-1\" // dice size at 0x16; negative values mean no change
    primary_type       = \"-1\" // primary school at 0x17; negative values mean no change
    dicenumber         = \"-1\" // number of dice at 0x18; negative values mean no change
    secondary_type     = \"-1\" // seoncdary type at 0x19; negative values mean no change
    damage_bonus       = \"-1\" // +damage bonus at 0x1a; negative values mean no change
    damage_type        = \"-1\" // damage type at 0x1c; negative values mean no change
//    effects_num        = \"-1\" // number of effects at 0x1e; negative values mean no change
//    effects_index      = \"-1\" // effects index at 0x20; negative values mean no change
    charges            = \"-1\" // number of charges at 0x22; negative values mean no change
    drained            = \"-1\" // when drained? at 0x24; negative values mean no change
    projectile         = \"-1\" // projectile at 0x2a; negative values mean no change
    animation_overhand = \"-1\" // % of overhand attacks at 0x2c; negative values mean no change
    animation_backhand = \"-1\" // % of backhand attacks at 0x2e; negative values mean no change
    animation_thrust   = \"-1\" // % of thrusting attacks at 0x30; negative values mean no change
    arrow              = \"-1\" // is arrow? at 0x32; negative values mean no change
    bolt               = \"-1\" // is bolt? at 0x34; negative values mean no change
    bullet             = \"-1\" // is bullet? at 0x36; negative values mean no change
    // flag_ vars affect flags starting at 0x26; 0 means remove flag, 1 means add flag, -1 no change
    flag_strength      = \"-1\" // add strength bonus, bit0
    flag_break         = \"-1\" // breakable, bit1
    flag_strength_damage = \"-1\" // EE, damage strength bonus, bit2
    flag_strength_thac0 = \"-1\" // EE, damage strength THAC0, bit3
    flag_hostile       = \"-1\" // hostile, bit10
    flag_recharge      = \"-1\" // recharge after resting, bit11
    flag_bypass        = \"-1\" // bypass armor, bit16
    flag_keenedge      = \"-1\" // keen edge, bit17
    flag_backstab      = \"-1\" // tobex only, can backstab, bit25
    flag_noinvisible   = \"-1\" // tobex only, cannot target invisible, bit26

    header_length = 0x38
  STR_VAR
    icon          = \"same\" // ability icon at 0x04; used to match if type > 4; same means no change otherwise use this value
BEGIN

  READ_LONG   0x64 \"abil_off\"
  READ_SHORT  0x68 \"abil_num\"
  PATCH_IF (header = 0) BEGIN SET loop_start = 0            SET loop_end = abil_num END
                   ELSE BEGIN SET loop_start = (header - 1) SET loop_end = header   END
  FOR (index = loop_start ; index < loop_end ; ++index) BEGIN
    READ_BYTE  (abil_off +        (index * header_length)) abil_type
    READ_ASCII (abil_off + 0x04 + (index * header_length)) icon_file
    PATCH_IF ((header_type < 0 AND !match_icon) OR (abil_type = header_type) OR ((match_icon = 1) AND (\"%icon_file%\" STRING_COMPARE_CASE \"%icon%\" = 0))) BEGIN
      SET ip = abil_off + (index * header_length)
      SET pro_off = header_length = 0x38 ? 0x2a : 0x26
      /* Some of these write lengths do not line up perfectly with the known SPL ability. Some
       * fields are bytes in the ITM ability but (presumed to be) words in the SPL ability.
       * However, legal values for the relevant fields never fall outside the byte range, so
       * we WRITE_BYTE regardless of header type. -Wisp
       */
      PATCH_IF (new_header_type >= 0)    BEGIN WRITE_BYTE  (ip)        new_header_type    END
      PATCH_IF (identify >= 0)           BEGIN WRITE_BYTE  (ip + 0x01) identify           END
      PATCH_IF (location >= 0)           BEGIN WRITE_BYTE  (ip + 0x02) location           END
      PATCH_IF (target >= 0)             BEGIN WRITE_BYTE  (ip + 0x0c) target             END
      PATCH_IF (target_count >= 0)       BEGIN WRITE_BYTE  (ip + 0x0d) target_count       END
      PATCH_IF (range >= 0)              BEGIN WRITE_SHORT (ip + 0x0e) range              END
      PATCH_IF (launcher_or_level >= 0)  BEGIN WRITE_BYTE  (ip + 0x10) launcher_or_level  END
      PATCH_IF (speed >= 0)              BEGIN WRITE_BYTE  (ip + 0x12) speed              END
      PATCH_IF (thac0_bonus >= 0)        BEGIN WRITE_SHORT (ip + 0x14) thac0_bonus        END
      PATCH_IF (dicesize >= 0)           BEGIN WRITE_BYTE  (ip + 0x16) dicesize           END
      PATCH_IF (primary_type >= 0)       BEGIN WRITE_BYTE  (ip + 0x17) primary_type       END
      PATCH_IF (dicenumber >= 0)         BEGIN WRITE_BYTE  (ip + 0x18) dicenumber         END
      PATCH_IF (secondary_type >= 0)     BEGIN WRITE_BYTE  (ip + 0x19) secondary_type     END
      PATCH_IF (damage_bonus >= 0)       BEGIN WRITE_SHORT (ip + 0x1a) damage_bonus       END
      PATCH_IF (damage_type >= 0)        BEGIN WRITE_SHORT (ip + 0x1c) damage_type        END
   /* PATCH_IF (effects_num >= 0)        BEGIN WRITE_SHORT (ip + 0x1e) effects_num        END
      PATCH_IF (effects_index >= 0)      BEGIN WRITE_SHORT (ip + 0x20) effects_index      END */
      PATCH_IF (charges >= 0)            BEGIN WRITE_SHORT (ip + 0x22) charges            END
      PATCH_IF (drained >= 0)            BEGIN WRITE_SHORT (ip + 0x24) drained            END
      PATCH_IF (projectile >= 0)         BEGIN WRITE_SHORT (ip + pro_off) projectile      END
      PATCH_IF (animation_overhand >= 0) BEGIN WRITE_SHORT (ip + 0x2c) animation_overhand END
      PATCH_IF (animation_backhand >= 0) BEGIN WRITE_SHORT (ip + 0x2e) animation_backhand END
      PATCH_IF (animation_thrust >= 0)   BEGIN WRITE_SHORT (ip + 0x30) animation_thrust   END
      PATCH_IF (arrow >= 0)              BEGIN WRITE_SHORT (ip + 0x32) arrow              END
      PATCH_IF (bolt >= 0)               BEGIN WRITE_SHORT (ip + 0x34) bolt               END
      PATCH_IF (bullet >= 0)             BEGIN WRITE_SHORT (ip + 0x36) bullet             END
      PATCH_IF (flag_strength = 0)       BEGIN WRITE_BYTE  (ip + 0x26) THIS & `BIT0       END
      PATCH_IF (flag_break = 0)          BEGIN WRITE_BYTE  (ip + 0x26) THIS & `BIT1       END
      PATCH_IF (flag_strength_damage = 0) BEGIN WRITE_BYTE (ip + 0x26) THIS & `BIT2       END
      PATCH_IF (flag_strength_thac0 = 0) BEGIN WRITE_BYTE  (ip + 0x26) THIS & `BIT3       END
      PATCH_IF (flag_hostile = 0)        BEGIN WRITE_BYTE  (ip + 0x27) THIS & `BIT2       END
      PATCH_IF (flag_recharge = 0)       BEGIN WRITE_BYTE  (ip + 0x27) THIS & `BIT3       END
      PATCH_IF (flag_bypass = 0)         BEGIN WRITE_BYTE  (ip + 0x28) THIS & `BIT0       END
      PATCH_IF (flag_keenedge = 0)       BEGIN WRITE_BYTE  (ip + 0x28) THIS & `BIT1       END
      PATCH_IF (flag_backstab = 0)       BEGIN WRITE_BYTE  (ip + 0x29) THIS & `BIT1       END
      PATCH_IF (flag_noinvisible = 0)    BEGIN WRITE_BYTE  (ip + 0x29) THIS & `BIT2       END
      PATCH_IF (flag_strength = 1)       BEGIN WRITE_BYTE  (ip + 0x26) THIS | BIT0        END
      PATCH_IF (flag_break = 1)          BEGIN WRITE_BYTE  (ip + 0x26) THIS | BIT1        END
      PATCH_IF (flag_strength_damage = 1) BEGIN WRITE_BYTE (ip + 0x26) THIS | BIT2        END
      PATCH_IF (flag_strength_thac0 = 1) BEGIN WRITE_BYTE  (ip + 0x26) THIS | BIT3        END
      PATCH_IF (flag_hostile = 1)        BEGIN WRITE_BYTE  (ip + 0x27) THIS | BIT2        END
      PATCH_IF (flag_recharge = 1)       BEGIN WRITE_BYTE  (ip + 0x27) THIS | BIT3        END
      PATCH_IF (flag_bypass = 1)         BEGIN WRITE_BYTE  (ip + 0x28) THIS | BIT0        END
      PATCH_IF (flag_keenedge = 1)       BEGIN WRITE_BYTE  (ip + 0x28) THIS | BIT1        END
      PATCH_IF (flag_backstab = 1)       BEGIN WRITE_BYTE  (ip + 0x29) THIS | BIT1        END
      PATCH_IF (flag_noinvisible = 1)    BEGIN WRITE_BYTE  (ip + 0x29) THIS | BIT2        END
      PATCH_IF (\"%icon%\" STRING_COMPARE_CASE \"same\") BEGIN
        WRITE_ASCIIE (ip + 0x04) \"%icon%\" #8
      END
    END
  END

END

DEFINE_PATCH_FUNCTION DELETE_ITMSPL_HEADER
  INT_VAR header_type = 0    // -1 for all headers, otherwise match type
          min_level   = \"-1\" // -1 for all headers, otherwise match
          header_length = 0x38
BEGIN

    READ_LONG   0x64 abil_off
    READ_SHORT  0x68 abil_num
    READ_LONG   0x6a fx_off
    READ_SHORT  0x70 fx_num
    SET fx_delta = 0
    FOR (index = 0 ; index < abil_num ; ++index) BEGIN // looks for default ability header
      READ_BYTE   (abil_off +        (index * header_length)) type_file
      READ_SHORT  (abil_off + 0x10 + (index * header_length)) min_level_file
      PATCH_IF (((header_type = type_file) OR (header_type < 0)) AND
                ((min_level = min_level_file) OR (min_level < 0))) BEGIN // default ability check
        READ_SHORT  (0x1e + abil_off + (index * header_length)) abil_fx_num
        READ_SHORT  (0x20 + abil_off + (index * header_length)) abil_fx_idx
        DELETE_BYTES (fx_off + (0x30 * (abil_fx_idx - fx_delta))) (0x30 * abil_fx_num) // deletes all associated effects
        DELETE_BYTES (abil_off + (index * header_length)) header_length                // deletes ability itself
        SET fx_delta = (fx_delta + abil_fx_num)
        SET abil_num = (abil_num - 1)
        SET index = (index - 1)
        SET fx_off = (fx_off - header_length)
      END ELSE BEGIN // if non-matched ability, need to adjust effect indices
        READ_SHORT  (0x20 + abil_off + (index * header_length)) abil_fx_idx
        WRITE_SHORT (0x20 + abil_off + (index * header_length)) (abil_fx_idx - fx_delta)
      END
    END
    WRITE_SHORT  0x68 abil_num
    WRITE_LONG   0x6a fx_off

END

/////                                                  \\\\\\\\\\
///// item functions                                   \\\\\\\\\\
/////                                                  \\\\\\\\\\

DEFINE_PATCH_FUNCTION ALTER_ITEM_EFFECT
  INT_VAR
    check_globals  = 0      // check global effects: 0 for no, 1 for yes
    check_headers  = 0      // check effects on headers; 0 for no, 1 for yes
    header         = 0      // add to this header; 0 for all headers
    header_type    = \"-1\"   // -1 to check all headers, otherwise use type specified
    match_opcode   = \"-1\"   // opcode at 0x00 to match, use -1 for all
    new_opcode     = \"-1\"   // if opcode matches, change to this value
    target         = \"-1\"   // change target at 0x02; negative values mean no change
    timing         = \"-1\"   // change timing at 0x0c; negative values mean no change
    power          = \"-1\"   // change power level at 0x03; negative values mean no change
    parameter1     = \"-1\"   // change parameter at 0x04; negative values mean no change
    parameter2     = \"-1\"   // change parameter at 0x08; negative values mean no change
    resist_dispel  = \"-1\"   // change resist/dispel at 0x0d; negative values mean no change
    duration       = \"-1\"   // change duration at 0x0e; negative values mean no change
    duration_high  = \"-1\"   // same as duration, but only if existing duration > 5
    probability1   = \"-1\"   // change high probability at 0x12; negative values mean no change
    probability2   = \"-1\"   // change low probability at 0x13; negative values mean no change
    dicenumber     = \"-1\"   // change number of dice at 0x1c; negative values mean no change
    dicesize       = \"-1\"   // change size of dice at 0x20; negative values mean no change
    savingthrow    = \"-1\"   // changing type of saving throw at 0x24; negative values mean no change
    savebonus      = \"-11\"  // change save bonus/penalty; values -11 or lower are ignored
    special        = \"-1\"
  STR_VAR
    resource       = \"same\" // resref at 0x14; same means no change, otherwise use this value
BEGIN

  LPF ALTER_ITMSPL_EFFECT
    INT_VAR
      check_globals
      check_headers
      header
      header_type
      match_opcode
      new_opcode
      target
      timing
      power
      parameter1
      parameter2
      resist_dispel
      duration
      duration_high
      probability1
      probability2
      dicenumber
      dicesize
      savingthrow
      savebonus
      special

      header_length = 0x38
    STR_VAR
      resource
  END

END

DEFINE_PATCH_FUNCTION ALTER_ITEM_HEADER
  INT_VAR header_type        = \"-1\" // -1 is all headers, otherwise use value here
          match_icon         = 0    // make icon match a qualifier, 0 = no, 1 = yes
          header             = 0    // 0 matches all headers, otherwise just modify specified header - use with type = -1
          new_header_type    = \"-1\" // change the type at 0x00 to this value; negative values mean no change
          identify           = \"-1\" // identify to use? at 0x01; negative values mean no change
          location           = \"-1\" // ability location at 0x02; negative values mean no change
          target             = \"-1\" // target at 0x0c; negative values mean no change
          target_count       = \"-1\" // target count at 0x0d; negative values mean no change
          range              = \"-1\" // range at 0x0e; negative values mean no change
          launcher           = \"-1\" // launcher required at 0x10; negative values mean no change
          speed              = \"-1\" // speed at 0x12; negative values mean no change
          thac0_bonus        = \"-1\" // to-hit bonus at 0x14; negative values mean no change
          dicesize           = \"-1\" // dice size at 0x16; negative values mean no change
          primary_type       = \"-1\" // primary school at 0x17; negative values mean no change
          dicenumber         = \"-1\" // number of dice at 0x18; negative values mean no change
          secondary_type     = \"-1\" // seoncdary type at 0x19; negative values mean no change
          damage_bonus       = \"-1\" // +damage bonus at 0x1a; negative values mean no change
          damage_type        = \"-1\" // damage type at 0x1c; negative values mean no change
//          effects_num        = \"-1\" // number of effects at 0x1e; negative values mean no change
//          effects_index      = \"-1\" // effects index at 0x20; negative values mean no change
          charges            = \"-1\" // number of charges at 0x22; negative values mean no change
          drained            = \"-1\" // when drained? at 0x24; negative values mean no change
          projectile         = \"-1\" // projectile at 0x2a; negative values mean no change
          animation_overhand = \"-1\" // % of overhand attacks at 0x2c; negative values mean no change
          animation_backhand = \"-1\" // % of backhand attacks at 0x2e; negative values mean no change
          animation_thrust   = \"-1\" // % of thrusting attacks at 0x30; negative values mean no change
          arrow              = \"-1\" // is arrow? at 0x32; negative values mean no change
          bolt               = \"-1\" // is bolt? at 0x34; negative values mean no change
          bullet             = \"-1\" // is bullet? at 0x36; negative values mean no change
          // flag_ vars affect flags starting at 0x26; 0 means remove flag, 1 means add flag, -1 no change
          flag_strength      = \"-1\" // add strength bonus, bit0
          flag_break         = \"-1\" // breakable, bit1
          flag_strength_damage = \"-1\" // EE, damage strength bonus, bit2
          flag_strength_thac0 = \"-1\" // EE, damage strength THAC0, bit3
          flag_hostile       = \"-1\" // hostile, bit10
          flag_recharge      = \"-1\" // recharge after resting, bit11
          flag_bypass        = \"-1\" // bypass armor, bit16
          flag_keenedge      = \"-1\" // keen edge, bit17
          flag_backstab      = \"-1\" // tobex only, can backstab, bit25
          flag_noinvisible   = \"-1\" // tobex only, cannot target invisible, bit26
  STR_VAR icon               = \"same\" // ability icon at 0x04; used to match if type > 4; same means no change otherwise use this value
BEGIN

  LPF ALTER_ITMSPL_HEADER
    INT_VAR
      header_type
      match_icon
      header
      new_header_type
      identify
      location
      target
      target_count
      range
      launcher_or_level = launcher
      speed
      thac0_bonus
      dicesize
      primary_type
      dicenumber
      secondary_type
      damage_bonus
      damage_type
      charges
      drained
      projectile
      animation_overhand
      animation_backhand
      animation_thrust
      arrow
      bolt
      bullet
      flag_strength
      flag_break
      flag_strength_damage
      flag_strength_thac0
      flag_hostile
      flag_recharge
      flag_bypass
      flag_keenedge
      flag_backstab
      flag_noinvisible

      header_length = 0x38
    STR_VAR
      icon
  END

END

DEFINE_PATCH_FUNCTION DELETE_ITEM_HEADER
  INT_VAR header_type = 0 // -1 for all headers, otherwise match type
BEGIN

  LPF DELETE_ITMSPL_HEADER
    INT_VAR
      header_type
      header_length = 0x38
  END

END

/////                                                  \\\\\\\\\\
///// spell functions                                  \\\\\\\\\\
/////                                                  \\\\\\\\\\

DEFINE_PATCH_FUNCTION ALTER_SPELL_EFFECT
  INT_VAR
    check_globals  = 0      // check global effects: 0 for no, 1 for yes
    check_headers  = 1      // check effects on headers; 0 for no, 1 for yes
    header         = 0      // add to this header; 0 for all headers
    header_type    = \"-1\"   // -1 to check all headers, otherwise use type specified
    match_opcode   = \"-1\"   // opcode at 0x00 to match, use -1 for all
    new_opcode     = \"-1\"   // if opcode matches, change to this value
    target         = \"-1\"   // change target at 0x02; negative values mean no change
    timing         = \"-1\"   // change timing at 0x0c; negative values mean no change
    power          = \"-1\"   // change power level at 0x03; negative values mean no change
    parameter1     = \"-1\"   // change parameter at 0x04; negative values mean no change
    parameter2     = \"-1\"   // change parameter at 0x08; negative values mean no change
    resist_dispel  = \"-1\"   // change resist/dispel at 0x0d; negative values mean no change
    duration       = \"-1\"   // change duration at 0x0e; negative values mean no change
    duration_high  = \"-1\"   // same as duration, but only if existing duration > 5
    probability1   = \"-1\"   // change high probability at 0x12; negative values mean no change
    probability2   = \"-1\"   // change low probability at 0x13; negative values mean no change
    dicenumber     = \"-1\"   // change number of dice at 0x1c; negative values mean no change
    dicesize       = \"-1\"   // change size of dice at 0x20; negative values mean no change
    savingthrow    = \"-1\"   // changing type of saving throw at 0x24; negative values mean no change
    savebonus      = \"-11\"  // change save bonus/penalty; values -11 or lower are ignored
    special        = \"-1\"   // change special; negative values mean no change
  STR_VAR
    resource       = \"same\" // resref at 0x14; same means no change, otherwise use this value
BEGIN
  LPF ALTER_ITMSPL_EFFECT
    INT_VAR
      check_globals
      check_headers
      header
      header_type
      match_opcode
      new_opcode
      target
      timing
      power
      parameter1
      parameter2
      resist_dispel
      duration
      duration_high
      probability1
      probability2
      dicenumber
      dicesize
      savingthrow
      savebonus
      special

      header_length = 0x28
    STR_VAR
      resource
  END

END

DEFINE_PATCH_FUNCTION ALTER_SPELL_HEADER
  INT_VAR header_type     = \"-1\" // -1 is all headers, otherwise use value here
          match_icon      = 0    // make icon match a qualifier, 0 = no, 1 = yes
          header          = 0    // 0 matches all headers, otherwise just modify specified header - use with type = -1
          new_header_type = \"-1\" // change the type at 0x00 to this value; negative values mean no change
          location        = \"-1\" // ability location at 0x02; negative values mean no change
          target          = \"-1\" // target at 0x0c; negative values mean no change
          target_count    = \"-1\" // target count at 0x0d; negative values mean no change
          range           = \"-1\" // range at 0x0e; negative values mean no change
          min_level       = \"-1\" // minimum level at 0x10; negative values mean no change
          speed           = \"-1\" // speed at 0x12; negative values mean no change
          thac0_bonus     = \"-1\" // to-hit bonus at 0x14; negative values mean no change
          dicesize        = \"-1\" // dice size at 0x16; negative values mean no change
          dicenumber      = \"-1\" // number of dice at 0x18; negative values mean no change
          damage_bonus    = \"-1\" // +damage bonus at 0x1a; negative values mean no change
          damage_type     = \"-1\" // damage type at 0x1c; negative values mean no change
//          effects_num     = \"-1\" // number of effects at 0x1e; negative values mean no change
//          effects_index   = \"-1\" // effects index at 0x20; negative values mean no change
          charges         = \"-1\" // number of charges at 0x22; negative values mean no change
          projectile      = \"-1\" // projectile at 0x26; negative values mean no change
  STR_VAR icon            = \"same\" // ability icon at 0x04; used to match if type > 4; same means no change otherwise use this value
BEGIN

  LPF ALTER_ITMSPL_HEADER
    INT_VAR
      header_type
      match_icon
      header
      new_header_type
      location
      target
      target_count
      range
      launcher_or_level = min_level
      speed
      thac0_bonus
      dicesize
      dicenumber
      damage_bonus
      damage_type
      charges
      projectile

      header_length = 0x28
    STR_VAR
      icon
  END

END

DEFINE_PATCH_FUNCTION DELETE_SPELL_HEADER
  INT_VAR header_type = 0    // -1 for all headers, otherwise match type
          min_level   = \"-1\" // -1 for all headers, otherwise match
BEGIN

  LPF DELETE_ITMSPL_HEADER
    INT_VAR
      header_type
      min_level
      header_length = 0x28
  END

END

DEFINE_PATCH_FUNCTION CLONE_EFFECT

  // defines what we\'re going to check
  INT_VAR check_globals       = 1
          check_headers       = 1
          header              = \"-1\"
          header_type         = \"-1\"
          multi_match         = 999
          verbose             = 0
          silent              = 0

  // variables for finding the effect to match
          match_opcode        = \"-1\"
          match_target        = \"-1\"
          match_power         = \"-1\"
          match_parameter1    = \"-1\"
          match_parameter2    = \"-1\"
          match_timing        = \"-1\"
          match_resist_dispel = \"-1\"
          match_duration      = \"-1\"
          match_duration_high = \"-1\"
          match_probability1  = \"-1\"
          match_probability2  = \"-1\"
          match_dicenumber    = \"-1\"
          match_dicesize      = \"-1\"
          match_savingthrow   = \"-1\"
          match_savebonus     = \"-11\"
          match_special       = \"-1\"

  // variables for the new effect
          opcode              = \"-1\"
          target              = \"-1\"
          power               = \"-1\"
          parameter1          = \"-1\"
          parameter2          = \"-1\"
          timing              = \"-1\"
          resist_dispel       = \"-1\"
          duration            = \"-1\"
          duration_high       = \"-1\"
          probability1        = \"-1\"
          probability2        = \"-1\"
          dicenumber          = \"-1\"
          dicesize            = \"-1\"
          savingthrow         = \"-1\"
          savebonus           = \"-11\"
          special             = \"-1\"

  // same for match and new STR_VAR
  STR_VAR match_resource      = \"SAME\"
          resource            = \"SAME\"
          insert              = \"above\"

BEGIN
  PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.1\" = 0) BEGIN // iwd2, are v9.1
    READ_LONG  0x78 ent_off
    READ_LONG  0x7c ent_num
  END ELSE BEGIN
    READ_LONG  0x68 ent_off
    READ_LONG  0x6c ent_num
  END

  // set variables and offsets based on the file type
  SET new_fx = 0
  READ_ASCII 0 sig ELSE \"fail\" (4)
  READ_ASCII 0x04 version (4)
  PATCH_MATCH \"%sig%\" WITH
    \"SPL \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.0\" = 0) BEGIN // iwd2, spl 2.0
        SET min_size       = 0x82
      END ELSE BEGIN
        SET min_size       = 0x72
      END
      READ_LONG   0x6a fx_off   ELSE 0
      SET counter_offset = 0x70
      SET abil_length    = 0x28
      SET fx_type        = 0
      READ_LONG   0x64 abil_off ELSE 0
      READ_SHORT  0x68 abil_num ELSE 0
    END

    \"ITM \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.1\" = 0) BEGIN // pst, itm v1.1
        SET min_size       = 0x9a
      END ELSE BEGIN
        SET min_size       = 0x72
      END
      READ_LONG   0x6a fx_off   ELSE 0
      SET counter_offset = 0x70
      SET abil_length    = 0x38
      SET fx_type        = 0
      READ_LONG   0x64 abil_off ELSE 0
      READ_SHORT  0x68 abil_num ELSE 0
    END

    \"CRE \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.2\" = 0) BEGIN // pst, cre v1.2
        SET min_size       = 0x378
        READ_LONG  0x368 fx_off
        SET counter_offset = 0x36c
      END ELSE
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.2\" = 0) BEGIN // iwd2, cre v2.2
        SET min_size       = 0x62e
        READ_LONG  0x61e fx_off
        SET counter_offset = 0x622
      END ELSE
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.0\" = 0) BEGIN // iwd, cre v9.0
        SET min_size       = 0x33c
        READ_LONG  0x32c fx_off
        SET counter_offset = 0x330
      END ELSE BEGIN                                               // everything else, cre v1.0
        SET min_size = 0x2d4
        READ_LONG  0x2c4 fx_off
        SET counter_offset = 0x2c8
      END
      SET abil_off = 0 // basically prevents the ability effect loop
      SET abil_num = 0
      SET abil_length = 0
      SET check_globals = 1
      READ_BYTE 0x33 fx_type ELSE 2
    END

    \"fail\"
    BEGIN
      PATCH_FAIL \"ERROR: CLONE_EFFECT does not think %SOURCE_FILE% appears to be a valid file\"
    END

    DEFAULT
      SET min_size = \"-1\" // kill macro as the file type is not recognized
      PATCH_FAIL \"ERROR: CLONE_EFFECT does not support file type %sig%\"
  END

  PATCH_IF (BUFFER_LENGTH >= min_size) BEGIN // sanity check
    FOR (index = (0 - check_globals) ; index < abil_num ; ++index) BEGIN // we start at -1 for global effects
      PATCH_IF (index < 0) BEGIN // if loop through globals needed
        SET abil_fx_idx = 0  // start with effect 0 since we\'re in the global loop
        SET abil_type = \"-1\" // basically, ignore header type checks for global loop
      END ELSE BEGIN // otherwise normal ability
        READ_BYTE   (abil_off +        (abil_length * index)) abil_type
        SET counter_offset = (abil_off + 0x1e + (abil_length * index))
        WRITE_SHORT (abil_off + 0x20 + (abil_length * index)) (THIS + new_fx) // update index with previously added effects
        READ_SHORT  (abil_off + 0x20 + (abil_length * index)) abil_fx_idx
      END
      READ_SHORT counter_offset counter // fx_num on global loop, otherwise abil_fx_num
      PATCH_IF (((abil_type = header_type) OR (abil_type < 0) OR (header_type < 0)) AND // only look on the right header types, if specified...
                ((header = index) OR (header < 0)) AND                                  // and only on the right # header, if specified
                ((index < 0) OR (check_headers))) BEGIN                                 // if check headers = 0, only re-index
        SET last = 0                              // and only on the right # header, if specified
        SET local_multi = multi_match
        FOR (index2 = 0 ; index2 < (counter - last) ; ++index2) BEGIN

          // read the variables from the current effect
          READ_SHORT (fx_off        + (0x08 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_opcode
          READ_BYTE  (fx_off + 0x02 + (0x0a * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_target
          READ_BYTE  (fx_off + 0x03 + (0x0d * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_power
          READ_LONG  (fx_off + 0x04 + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_parameter1
          READ_LONG  (fx_off + 0x08 + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_parameter2
          READ_BYTE  (fx_off + 0x0c + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_timing
          READ_BYTE  (fx_off + 0x0d + (0x47 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_resist_dispel
          READ_LONG  (fx_off + 0x0e + (0x12 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_duration
          READ_BYTE  (fx_off + 0x12 + (0x12 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_probability1
          READ_BYTE  (fx_off + 0x13 + (0x13 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_probability2
          READ_ASCII (fx_off + 0x14 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_resource
          READ_LONG  (fx_off + 0x1c + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_dicenumber
          READ_LONG  (fx_off + 0x20 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_dicesize
          READ_LONG  (fx_off + 0x24 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_savingthrow
          READ_LONG  (fx_off + 0x28 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_savebonus
          READ_LONG  (fx_off + 0x2c + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_special

          // match ALL these variables, if specified
          PATCH_IF (((match_opcode        = o_opcode)        OR (match_opcode < 0))        AND
                    ((match_target        = o_target)        OR (match_target < 0))        AND
                    ((match_power         = o_power)         OR (match_power < 0))         AND
                    ((match_parameter1    = o_parameter1)    OR (match_parameter1 < 0))    AND
                    ((match_parameter2    = o_parameter2)    OR (match_parameter2 < 0))    AND
                    ((match_timing        = o_timing)        OR (match_timing < 0))        AND
                    ((match_resist_dispel = o_resist_dispel) OR (match_resist_dispel < 0)) AND
                    ((match_duration      = o_duration)      OR (match_duration < 0))      AND
                    ((match_probability1  = o_probability1)  OR (match_probability1 < 0))  AND
                    ((match_probability2  = o_probability2)  OR (match_probability2 < 0))  AND
                    ((match_dicenumber    = o_dicenumber)    OR (match_dicenumber < 0))    AND
                    ((match_dicesize      = o_dicesize)      OR (match_dicesize < 0))      AND
                    ((match_savingthrow   = o_savingthrow)   OR (match_savingthrow < 0))   AND
                    ((match_savebonus     = o_savebonus)     OR (match_savebonus < \"-10\")) AND
                    ((match_special       = o_special)       OR (match_special < 0))       AND
                    ((\"%match_resource%\" STRING_COMPARE_CASE \"%o_resource%\" = 0) OR (\"%match_resource%\" STRING_COMPARE_CASE \"SAME\" = 0)))
          BEGIN

            // now that we\'ve got a match, read-and-clone it:
            READ_ASCII   (fx_off        + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) clone (0x30 + (0xd8 * fx_type))
            PATCH_IF (\"%insert%\" STRING_COMPARE_CASE \"below\" = 0) BEGIN
              SET base = (fx_off        + ((abil_fx_idx + index2 + 1) * (0x30 + (0xd8 * fx_type))))
            END ELSE
            PATCH_IF (\"%insert%\" STRING_COMPARE_CASE \"first\" = 0) BEGIN
              SET base = (fx_off        + (abil_fx_idx * (0x30 + (0xd8 * fx_type))))
            END ELSE
            PATCH_IF (\"%insert%\" STRING_COMPARE_CASE \"last\" = 0) BEGIN
              SET base = (fx_off        + ((abil_fx_idx + counter) * (0x30 + (0xd8 * fx_type))))
            END ELSE BEGIN
              SET base = (fx_off        + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type))))
            END
            INSERT_BYTES base (0x30 + (0xd8 * fx_type))
            WRITE_ASCIIE base \"%clone%\"

            // overwrite the cloned effect with the new variables, if specified
            PATCH_IF (opcode >= 0)        BEGIN WRITE_SHORT (base        + (0x08 * fx_type)) opcode        END
            PATCH_IF (target >= 0)        BEGIN WRITE_BYTE  (base + 0x02 + (0x0a * fx_type)) target        END
            PATCH_IF (power >= 0)         BEGIN WRITE_BYTE  (base + 0x03 + (0x0d * fx_type)) power         END
            PATCH_IF (parameter1 >= 0)    BEGIN WRITE_LONG  (base + 0x04 + (0x10 * fx_type)) parameter1    END
            PATCH_IF (parameter2 >= 0)    BEGIN WRITE_LONG  (base + 0x08 + (0x10 * fx_type)) parameter2    END
            PATCH_IF (timing >= 0)        BEGIN WRITE_BYTE  (base + 0x0c + (0x10 * fx_type)) timing        END
            PATCH_IF (resist_dispel >= 0) BEGIN WRITE_BYTE  (base + 0x0d + (0x47 * fx_type)) resist_dispel END
            PATCH_IF (duration >= 0)      BEGIN WRITE_LONG  (base + 0x0e + (0x12 * fx_type)) duration      END
            PATCH_IF (probability1 >= 0)  BEGIN WRITE_BYTE  (base + 0x12 + (0x12 * fx_type)) probability1  END
            PATCH_IF (probability2 >= 0)  BEGIN WRITE_BYTE  (base + 0x13 + (0x13 * fx_type)) probability2  END
            PATCH_IF (dicenumber >= 0)    BEGIN WRITE_LONG  (base + 0x1c + (0x14 * fx_type)) dicenumber    END
            PATCH_IF (dicesize >= 0)      BEGIN WRITE_LONG  (base + 0x20 + (0x14 * fx_type)) dicesize      END
            PATCH_IF (savingthrow >= 0)   BEGIN WRITE_LONG  (base + 0x24 + (0x14 * fx_type)) savingthrow   END
            PATCH_IF (savebonus >= \"-10\") BEGIN WRITE_LONG  (base + 0x28 + (0x14 * fx_type)) savebonus     END
            PATCH_IF (special >= 0)       BEGIN WRITE_LONG  (base + 0x2c + (0x14 * fx_type)) special       END
            PATCH_IF (\"%resource%\" STRING_COMPARE_CASE \"SAME\" != 0) BEGIN
              WRITE_ASCIIE (base + 0x14 + (0x14 * fx_type)) \"%resource%\" #8
            END

            // update the tracking vars
            SET new_fx += 1
            SET counter += 1
            PATCH_IF (local_multi < 2) BEGIN  // kill loop if we only want one match
              SET index2 = counter
            END ELSE BEGIN // otherwise bump vars and keep going
              SET local_multi  -= 1
              PATCH_IF (\"%insert%\" STRING_COMPARE_CASE \"last\" = 0) BEGIN
                SET last += 1
              END ELSE BEGIN
                SET index2 += 1
              END
            END

          END // end patch_if for a matched effect
        END // end of the for loop through effects
      END // end patch_if for matched/specified headers
      WRITE_SHORT counter_offset counter // fx_num on global loop, otherwise abil_fx_num
    END // end loop through effects on ability
  END // end ability loop

  // now adjust offsets for creature files
  PATCH_IF ((\"%sig%\" STRING_EQUAL \"CRE \") AND (new_fx > 0)) BEGIN // fix offsets for cre files if fx inserted
    SET inserted = ((0x30 + (0xd8 * fx_type)) * new_fx)
    PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.2\" = 0) BEGIN // pst, cre v1.2
      PATCH_FOR_EACH offset IN 0x294 0x344 0x34c 0x354 0x35c 0x360 BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END ELSE
    PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.2\" = 0) BEGIN // iwd2, cre v2.2
      PATCH_FOR_EACH offset IN 0x5fa 0x602 0x60a 0x612 0x616 BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
      FOR (offset = 0x3ba ; offset < 0x4b3 ; offset = offset + 0x04) BEGIN // all of the spell offsets
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
      FOR (offset = 0x5b2 ; offset < 0x5d3 ; offset = offset + 0x04) BEGIN // domain spell offsets
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END ELSE
    PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.0\" = 0) BEGIN // iwd, cre v9.0
      PATCH_FOR_EACH offset IN 0x308 0x310 0x318 0x320 0x324 BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END ELSE BEGIN                                               // everything else, cre v1.0
      PATCH_FOR_EACH offset IN 0x2a0 0x2a8 0x2b0 0x2b8 0x2bc BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END
  END

  PATCH_IF (new_fx = 0 && !silent) BEGIN
    PATCH_WARN \"WARNING: no effects added to %SOURCE_FILE%\"
  END ELSE PATCH_IF (verbose && !silent) BEGIN
    READ_LONG 0x0c strref
    PATCH_IF ((strref > 0) AND (strref < 200000)) BEGIN
      READ_STRREF 0x0c name
    END ELSE BEGIN
      READ_STRREF 0x08 name
    END
    PATCH_PRINT \"              ~%SOURCE_FILE%~   ~override~ // %name%, %new_fx% effect(s) added\"
  END

END

DEFINE_PATCH_FUNCTION DELETE_EFFECT

  // defines what we\'re going to check
  INT_VAR check_globals       = 1
          check_headers       = 1
          header              = \"-1\"
          header_type         = \"-1\"
          multi_match         = 999
          verbose             = 0

  // variables for finding the effect to match
          match_opcode        = \"-1\"
          match_target        = \"-1\"
          match_power         = \"-1\"
          match_parameter1    = \"-1\"
          match_parameter2    = \"-1\"
          match_timing        = \"-1\"
          match_resist_dispel = \"-1\"
          match_duration      = \"-1\"
          match_duration_high = \"-1\"
          match_probability1  = \"-1\"
          match_probability2  = \"-1\"
          match_dicenumber    = \"-1\"
          match_dicesize      = \"-1\"
          match_savingthrow   = \"-1\"
          match_savebonus     = \"-11\"
          match_special       = \"-1\"

  // same for match and new STR_VAR
  STR_VAR match_resource      = \"SAME\"

BEGIN

  // set variables and offsets based on the file type
  SET new_fx = 0
  READ_ASCII 0 sig ELSE \"fail\" (4)
  READ_ASCII 0x04 version (4)
  PATCH_MATCH \"%sig%\" WITH
    \"SPL \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.0\" = 0) BEGIN // iwd2, spl 2.0
        SET min_size       = 0x82
      END ELSE BEGIN
        SET min_size       = 0x72
      END
      READ_LONG   0x6a fx_off   ELSE 0
      SET counter_offset = 0x70
      SET abil_length    = 0x28
      SET fx_type        = 0
      READ_LONG   0x64 abil_off ELSE 0
      READ_SHORT  0x68 abil_num ELSE 0
    END

    \"ITM \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.1\" = 0) BEGIN // pst, itm v1.1
        SET min_size       = 0x9a
      END ELSE BEGIN
        SET min_size       = 0x72
      END
      READ_LONG   0x6a fx_off   ELSE 0
      SET counter_offset = 0x70
      SET abil_length    = 0x38
      SET fx_type        = 0
      READ_LONG   0x64 abil_off ELSE 0
      READ_SHORT  0x68 abil_num ELSE 0
    END

    \"CRE \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.2\" = 0) BEGIN // pst, cre v1.2
        SET min_size       = 0x378
        READ_LONG  0x368 fx_off
        SET counter_offset = 0x36c
      END ELSE
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.2\" = 0) BEGIN // iwd2, cre v2.2
        SET min_size       = 0x62e
        READ_LONG  0x61e fx_off
        SET counter_offset = 0x622
      END ELSE
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.0\" = 0) BEGIN // iwd, cre v9.0
        SET min_size       = 0x33c
        READ_LONG  0x32c fx_off
        SET counter_offset = 0x330
      END ELSE BEGIN                                               // everything else, cre v1.0
        SET min_size = 0x2d4
        READ_LONG  0x2c4 fx_off
        SET counter_offset = 0x2c8
      END
      SET abil_off = 0 // basically prevents the ability effect loop
      SET abil_num = 0
      SET abil_length = 0
      SET check_globals = 1
      READ_BYTE 0x33 fx_type ELSE 2
    END

    \"fail\"
    BEGIN
      PATCH_WARN \"WARNING: DELETE_EFFECT does not think %SOURCE_FILE% appears to be a valid file\"
    END

    DEFAULT
      SET min_size = \"-1\" // kill macro as the file type is not recognized
      PATCH_WARN \"WARNING: DELETE_EFFECT does not support file type %sig%\"
  END

  PATCH_IF (BUFFER_LENGTH >= min_size) BEGIN // sanity check
    FOR (index = (0 - check_globals) ; index < abil_num ; ++index) BEGIN // we start at -1 for global effects
      PATCH_IF (index < 0) BEGIN // if loop through globals needed
        SET abil_fx_idx = 0  // start with effect 0 since we\'re in the global loop
        SET abil_type = \"-1\" // basically, ignore header type checks for global loop
      END ELSE BEGIN // otherwise normal ability
        READ_BYTE   (abil_off +        (abil_length * index)) abil_type
        SET counter_offset = (abil_off + 0x1e + (abil_length * index))
        WRITE_SHORT (abil_off + 0x20 + (abil_length * index)) (THIS + new_fx) // update index with previously added effects
        READ_SHORT  (abil_off + 0x20 + (abil_length * index)) abil_fx_idx
      END
      READ_SHORT counter_offset counter // fx_num on global loop, otherwise abil_fx_num
      PATCH_IF (((abil_type = header_type) OR (abil_type < 0) OR (header_type < 0)) AND // only look on the right header types, if specified...
                ((header = index) OR (header < 0)) AND                                  // and only on the right # header, if specified
                ((index < 0) OR (check_headers))) BEGIN                                 // if check headers = 0, only re-index
        SET local_multi = multi_match
        FOR (index2 = 0 ; index2 < counter ; ++index2) BEGIN

          // read the variables from the current effect
          READ_SHORT (fx_off        + (0x08 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_opcode
          READ_BYTE  (fx_off + 0x02 + (0x0a * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_target
          READ_BYTE  (fx_off + 0x03 + (0x0d * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_power
          READ_LONG  (fx_off + 0x04 + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_parameter1
          READ_LONG  (fx_off + 0x08 + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_parameter2
          READ_BYTE  (fx_off + 0x0c + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_timing
          READ_BYTE  (fx_off + 0x0d + (0x47 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_resist_dispel
          READ_LONG  (fx_off + 0x0e + (0x12 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_duration
          READ_BYTE  (fx_off + 0x12 + (0x12 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_probability1
          READ_BYTE  (fx_off + 0x13 + (0x13 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_probability2
          READ_ASCII (fx_off + 0x14 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_resource
          READ_LONG  (fx_off + 0x1c + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_dicenumber
          READ_LONG  (fx_off + 0x20 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_dicesize
          READ_LONG  (fx_off + 0x24 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_savingthrow
          READ_LONG  (fx_off + 0x28 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_savebonus
          READ_LONG  (fx_off + 0x2c + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_special

          // match ALL these variables, if specified
          PATCH_IF (((match_opcode        = o_opcode)        OR (match_opcode < 0))        AND
                    ((match_target        = o_target)        OR (match_target < 0))        AND
                    ((match_power         = o_power)         OR (match_power < 0))         AND
                    ((match_parameter1    = o_parameter1)    OR (match_parameter1 < 0))    AND
                    ((match_parameter2    = o_parameter2)    OR (match_parameter2 < 0))    AND
                    ((match_timing        = o_timing)        OR (match_timing < 0))        AND
                    ((match_resist_dispel = o_resist_dispel) OR (match_resist_dispel < 0)) AND
                    ((match_duration      = o_duration)      OR (match_duration < 0))      AND
                    ((match_probability1  = o_probability1)  OR (match_probability1 < 0))  AND
                    ((match_probability2  = o_probability2)  OR (match_probability2 < 0))  AND
                    ((match_dicenumber    = o_dicenumber)    OR (match_dicenumber < 0))    AND
                    ((match_dicesize      = o_dicesize)      OR (match_dicesize < 0))      AND
                    ((match_savingthrow   = o_savingthrow)   OR (match_savingthrow < 0))   AND
                    ((match_savebonus     = o_savebonus)     OR (match_savebonus < \"-10\")) AND
                    ((match_special       = o_special)       OR (match_special < 0))       AND
                    ((\"%match_resource%\" STRING_COMPARE_CASE \"%o_resource%\" = 0) OR (\"%match_resource%\" STRING_COMPARE_CASE \"SAME\" = 0))) BEGIN

            // now that we\'ve got a match, read-and-clone it:
            DELETE_BYTES   (fx_off        + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) (0x30 + (0xd8 * fx_type))

            // update the tracking vars
            SET new_fx -= 1
            SET counter -= 1
            SET index2 -= 1
            PATCH_IF (local_multi < 2) BEGIN  // kill loop if we only want one match
              SET index2 = counter
            END ELSE BEGIN // otherwise bump vars and keep going
              SET local_multi  -= 1
            END

          END // end patch_if for a matched effect
        END // end of the for loop through effects
      END // end patch_if for matched/specified headers
      WRITE_SHORT counter_offset counter // fx_num on global loop, otherwise abil_fx_num
    END // end loop through effects on ability
  END // end ability loop

  // now adjust offsets for creature files
  PATCH_IF ((\"%sig%\" STRING_EQUAL \"CRE \") AND (new_fx != 0)) BEGIN // fix offsets for cre files if #fx changed
    SET inserted = ((0x30 + (0xd8 * fx_type)) * new_fx)
    PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.2\" = 0) BEGIN // pst, cre v1.2
      PATCH_FOR_EACH offset IN 0x294 0x344 0x34c 0x354 0x35c 0x360 BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END ELSE
    PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.2\" = 0) BEGIN // iwd2, cre v2.2
      PATCH_FOR_EACH offset IN 0x5fa 0x602 0x60a 0x612 0x616 BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
      FOR (offset = 0x3ba ; offset < 0x4b3 ; offset = offset + 0x04) BEGIN // all of the spell offsets
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
      FOR (offset = 0x5b2 ; offset < 0x5d3 ; offset = offset + 0x04) BEGIN // domain spell offsets
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END ELSE
    PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.0\" = 0) BEGIN // iwd, cre v9.0
      PATCH_FOR_EACH offset IN 0x308 0x310 0x318 0x320 0x324 BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END ELSE BEGIN                                               // everything else, cre v1.0
      PATCH_FOR_EACH offset IN 0x2a0 0x2a8 0x2b0 0x2b8 0x2bc BEGIN
        READ_LONG offset off
        PATCH_IF (fx_off < off) BEGIN
          WRITE_LONG offset (off + inserted)
        END
      END
    END
  END

  PATCH_IF (verbose) BEGIN
    READ_LONG 0x0c strref
    PATCH_IF ((strref > 0) AND (strref < 200000)) BEGIN
      READ_STRREF 0x0c name
    END ELSE BEGIN
      READ_STRREF 0x08 name
    END
    PATCH_PRINT \"              ~%SOURCE_FILE%~   ~override~ // %name%, %new_fx% effect(s) deleted\"
  END

END

DEFINE_PATCH_FUNCTION ALTER_EFFECT

  // defines what we\'re going to check
  INT_VAR check_globals       = 1
          check_headers       = 1
          header              = \"-1\"
          header_type         = \"-1\"
          multi_match         = 999
          verbose             = 0
          silent              = 0

  // variables for finding the effect to match
          match_opcode        = \"-1\"
          match_target        = \"-1\"
          match_power         = \"-1\"
          match_parameter1    = \"-1\"
          match_parameter2    = \"-1\"
          match_timing        = \"-1\"
          match_resist_dispel = \"-1\"
          match_duration      = \"-1\"
          match_duration_high = \"-1\"
          match_probability1  = \"-1\"
          match_probability2  = \"-1\"
          match_dicenumber    = \"-1\"
          match_dicesize      = \"-1\"
          match_savingthrow   = \"-1\"
          match_savebonus     = \"-11\"
          match_special       = \"-1\"

  // variables for the new effect
          opcode              = \"-1\"
          target              = \"-1\"
          power               = \"-1\"
          parameter1          = \"-1\"
          parameter2          = \"-1\"
          timing              = \"-1\"
          resist_dispel       = \"-1\"
          duration            = \"-1\"
          duration_high       = \"-1\"
          probability1        = \"-1\"
          probability2        = \"-1\"
          dicenumber          = \"-1\"
          dicesize            = \"-1\"
          savingthrow         = \"-1\"
          savebonus           = \"-11\"
          special             = \"-1\"

  // same for match and new STR_VAR
  STR_VAR match_resource      = \"SAME\"
          resource            = \"SAME\"

BEGIN  

  // set variables and offsets based on the file type
  SET alter = 0
  READ_ASCII 0 sig ELSE \"fail\" (4)
  READ_ASCII 0x04 version (4)
  PATCH_MATCH \"%sig%\" WITH
    \"SPL \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.0\" = 0) BEGIN // iwd2, spl 2.0
        SET min_size       = 0x82
      END ELSE BEGIN
        SET min_size       = 0x72
      END
      READ_LONG   0x6a fx_off   ELSE 0
      SET counter_offset = 0x70
      SET abil_length    = 0x28
      SET fx_type        = 0
      PATCH_IF (check_headers = 0) BEGIN
        SET abil_num = 0
      END ELSE BEGIN
        READ_LONG   0x64 abil_off ELSE 0
        READ_SHORT  0x68 abil_num ELSE 0
      END
    END

    \"ITM \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.1\" = 0) BEGIN // pst, itm v1.1
        SET min_size       = 0x9a
      END ELSE BEGIN
        SET min_size       = 0x72
      END
      READ_LONG   0x6a fx_off   ELSE 0
      SET counter_offset = 0x70
      SET abil_length    = 0x38
      SET fx_type        = 0
      PATCH_IF (check_headers = 0) BEGIN
        SET abil_num = 0
      END ELSE BEGIN
        READ_LONG   0x64 abil_off ELSE 0
        READ_SHORT  0x68 abil_num ELSE 0
      END
    END

    \"CRE \"
    BEGIN
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V1.2\" = 0) BEGIN // pst, cre v1.2
        SET min_size       = 0x378
        READ_LONG  0x368 fx_off ELSE 0
        SET counter_offset = 0x36c
      END ELSE
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V2.2\" = 0) BEGIN // iwd2, cre v2.2
        SET min_size       = 0x62e
        READ_LONG  0x61e fx_off ELSE 0
        SET counter_offset = 0x622
      END ELSE
      PATCH_IF (\"%version%\" STRING_COMPARE_CASE \"V9.0\" = 0) BEGIN // iwd, cre v9.0
        SET min_size       = 0x33c
        READ_LONG  0x32c fx_off ELSE 0
        SET counter_offset = 0x330
      END ELSE BEGIN                                               // everything else, cre v1.0
        SET min_size = 0x2d4
        READ_LONG  0x2c4 fx_off ELSE 0
        SET counter_offset = 0x2c8
      END
      SET abil_off = 0 // basically prevents the ability effect loop
      SET abil_num = 0
      SET abil_length = 0
      SET check_globals = 1
      READ_BYTE 0x33 fx_type ELSE 2
    END

    \"fail\"
    BEGIN
      PATCH_WARN \"WARNING: ALTER_EFFECT does not think %SOURCE_FILE% appears to be a valid file\"
    END

    DEFAULT
      SET min_size = \"-1\" // kill macro as the file type is not recognized
      PATCH_WARN \"WARNING: ALTER_EFFECT does not support file type %sig%\"
  END

  PATCH_IF (BUFFER_LENGTH >= min_size) BEGIN // sanity check
    FOR (index = (0 - check_globals) ; index < abil_num ; ++index) BEGIN // we start at -1 for global effects
      PATCH_IF (index < 0) BEGIN // if loop through globals needed
        SET abil_fx_idx = 0  // start with effect 0 since we\'re in the global loop
        SET abil_type = \"-1\" // basically, ignore header type checks for global loop
      END ELSE BEGIN // otherwise normal ability
        READ_BYTE   (abil_off +        (abil_length * index)) abil_type
        SET counter_offset = (abil_off + 0x1e + (abil_length * index))
        READ_SHORT  (abil_off + 0x20 + (abil_length * index)) abil_fx_idx
      END
      READ_SHORT counter_offset counter // fx_num on global loop, otherwise abil_fx_num
      PATCH_IF (((abil_type = header_type) OR (abil_type < 0) OR (header_type < 0)) AND // only look on the right header types, if specified...
                ((header = index) OR (header < 0))) BEGIN                               // and only on the right # header, if specified
        SET local_multi = multi_match
        FOR (index2 = 0 ; index2 < counter ; ++index2) BEGIN

          // read the variables from the current effect
          READ_SHORT (fx_off        + (0x08 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_opcode
          READ_BYTE  (fx_off + 0x02 + (0x0a * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_target
          READ_BYTE  (fx_off + 0x03 + (0x0d * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_power
          READ_LONG  (fx_off + 0x04 + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_parameter1
          READ_LONG  (fx_off + 0x08 + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_parameter2
          READ_BYTE  (fx_off + 0x0c + (0x10 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_timing
          READ_BYTE  (fx_off + 0x0d + (0x47 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_resist_dispel
          READ_LONG  (fx_off + 0x0e + (0x12 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_duration
          READ_BYTE  (fx_off + 0x12 + (0x12 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_probability1
          READ_BYTE  (fx_off + 0x13 + (0x13 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_probability2
          READ_ASCII (fx_off + 0x14 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_resource
          READ_LONG  (fx_off + 0x1c + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_dicenumber
          READ_LONG  (fx_off + 0x20 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_dicesize
          READ_LONG  (fx_off + 0x24 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_savingthrow
          READ_LONG  (fx_off + 0x28 + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_savebonus
          READ_LONG  (fx_off + 0x2c + (0x14 * fx_type) + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type)))) o_special

          // match ALL these variables, if specified
          PATCH_IF (((match_opcode        = o_opcode)        OR (match_opcode < 0))        AND
                    ((match_target        = o_target)        OR (match_target < 0))        AND
                    ((match_power         = o_power)         OR (match_power < 0))         AND
                    ((match_parameter1    = o_parameter1)    OR (match_parameter1 < 0))    AND
                    ((match_parameter2    = o_parameter2)    OR (match_parameter2 < 0))    AND
                    ((match_timing        = o_timing)        OR (match_timing < 0))        AND
                    ((match_resist_dispel = o_resist_dispel) OR (match_resist_dispel < 0)) AND
                    ((match_duration      = o_duration)      OR (match_duration < 0))      AND
                    ((match_probability1  = o_probability1)  OR (match_probability1 < 0))  AND
                    ((match_probability2  = o_probability2)  OR (match_probability2 < 0))  AND
                    ((match_dicenumber    = o_dicenumber)    OR (match_dicenumber < 0))    AND
                    ((match_dicesize      = o_dicesize)      OR (match_dicesize < 0))      AND
                    ((match_savingthrow   = o_savingthrow)   OR (match_savingthrow < 0))   AND
                    ((match_savebonus     = o_savebonus)     OR (match_savebonus < \"-10\")) AND
                    ((match_special       = o_special)       OR (match_special < 0))       AND
                    ((\"%match_resource%\" STRING_COMPARE_CASE \"%o_resource%\" = 0) OR (\"%match_resource%\" STRING_COMPARE_CASE \"SAME\" = 0))) BEGIN

            // lazily re-use code
            SET base = (fx_off        + ((abil_fx_idx + index2) * (0x30 + (0xd8 * fx_type))))

            // overwrite the cloned effect with the new variables, if specified
            PATCH_IF (opcode >= 0)        BEGIN WRITE_SHORT (base        + (0x08 * fx_type)) opcode        END
            PATCH_IF (target >= 0)        BEGIN WRITE_BYTE  (base + 0x02 + (0x0a * fx_type)) target        END
            PATCH_IF (power >= 0)         BEGIN WRITE_BYTE  (base + 0x03 + (0x0d * fx_type)) power         END
            PATCH_IF (parameter1 >= 0)    BEGIN WRITE_LONG  (base + 0x04 + (0x10 * fx_type)) parameter1    END
            PATCH_IF (parameter2 >= 0)    BEGIN WRITE_LONG  (base + 0x08 + (0x10 * fx_type)) parameter2    END
            PATCH_IF (timing >= 0)        BEGIN WRITE_BYTE  (base + 0x0c + (0x10 * fx_type)) timing        END
            PATCH_IF (resist_dispel >= 0) BEGIN WRITE_BYTE  (base + 0x0d + (0x47 * fx_type)) resist_dispel END
            PATCH_IF (duration >= 0)      BEGIN WRITE_LONG  (base + 0x0e + (0x12 * fx_type)) duration      END
            PATCH_IF (probability1 >= 0)  BEGIN WRITE_BYTE  (base + 0x12 + (0x12 * fx_type)) probability1  END
            PATCH_IF (probability2 >= 0)  BEGIN WRITE_BYTE  (base + 0x13 + (0x13 * fx_type)) probability2  END
            PATCH_IF (dicenumber >= 0)    BEGIN WRITE_LONG  (base + 0x1c + (0x14 * fx_type)) dicenumber    END
            PATCH_IF (dicesize >= 0)      BEGIN WRITE_LONG  (base + 0x20 + (0x14 * fx_type)) dicesize      END
            PATCH_IF (savingthrow >= 0)   BEGIN WRITE_LONG  (base + 0x24 + (0x14 * fx_type)) savingthrow   END
            PATCH_IF (savebonus >= \"-10\") BEGIN WRITE_LONG  (base + 0x28 + (0x14 * fx_type)) savebonus     END
            PATCH_IF (special >= 0)       BEGIN WRITE_LONG  (base + 0x2c + (0x14 * fx_type)) special       END
            PATCH_IF (\"%resource%\" STRING_COMPARE_CASE \"SAME\" != 0) BEGIN
              WRITE_ASCIIE (base + 0x14 + (0x14 * fx_type)) \"%resource%\" #8
            END

            // update the tracking vars
            SET alter += 1
            PATCH_IF (local_multi < 2) BEGIN  // kill loop if we only want one match
              SET index2 = counter
            END ELSE BEGIN // otherwise bump vars and keep going
              SET local_multi  -= 1
            END

          END // end patch_if for a matched effect
        END // end of the for loop through effects
      END // end patch_if for matched/specified headers
    END // end loop through effects on ability
  END // end ability loop

  PATCH_IF (alter = 0 && !silent) BEGIN
    PATCH_WARN \"WARNING: no effects altered on %SOURCE_FILE%\"
  END

  PATCH_IF (verbose && !silent) BEGIN
    READ_LONG 0x0c strref
    PATCH_IF ((strref > 0) AND (strref < 200000)) BEGIN
      READ_STRREF 0x0c name
    END ELSE BEGIN
      READ_STRREF 0x08 name
    END
    PATCH_PRINT \"              ~%SOURCE_FILE%~   ~override~ // %name%, %alter% effect(s) altered\"
  END

END
  ");
(".../WEIDU_NAMESPACE/fj_are_struct.tpa","DEFINE_PATCH_FUNCTION fj_are_structure

  // let\'s set up our variables! i++++ 4eva

  INT_VAR

  // these are internal variables, not to be used as input
  is_bg2               = ENGINE_IS ~soa tob pstee~ OR FILE_EXISTS_IN_GAME monkfist.2da
  is_pst               = ENGINE_IS pst
  is_id2               = ENGINE_IS iwd2
  fj_position          = 0x11c
  fj_itm_idx           = 0
  fj_vertex_idx        = 0
  off                  = 0
  num                  = 0
  off1                 = 0
  num1                 = 0
  key                  = 0
  value                = 0
  key1                 = 0
  value1               = 0
  fj_return_offset     = 0
  fj_deleted           = 0

  // instead of adding fj_structure_type, delete if num == fj_delete_mode
  fj_delete_mode       = ` 0

  // offsets to various structures unpointed at zero
  fj_unzero_header_off = 0

  // spams your console with psuedoinformative nonsense
  fj_debug             = 0

  // actors
  fj_loc_x             = 0
  fj_loc_y             = 0
  fj_dest_x            = fj_loc_x
  fj_dest_y            = fj_loc_y
  fj_loading           = 1
  fj_spawned           = 0
  fj_animation         = 0
  fj_orientation       = 0
  fj_expiry            = ` 0
  fj_wander_dist_actor = 0
  fj_mvmt_dist_actor   = 0
  fj_schedule          = ` 0
  fj_num_talked        = 0

  // regions
  fj_type              = 0
  fj_box_left          = 0
  fj_box_top           = 0
  fj_box_right         = 0
  fj_box_bottom        = 0
  fj_cursor_idx        = 0
  fj_flags             = 0
  fj_info_point_strref = ` 0
  fj_trap_detect       = 0
  fj_trap_remove       = 0
  fj_trap_active       = 0
  fj_trap_status       = 0
  fj_alt_x             = 0
  fj_alt_y             = 0
  fj_talk_loc_x        = 0 // only for PST
  fj_talk_loc_y        = 0 // only for PST
  fj_speaker_strref    = ` 0 // only for PST

  // spawns
  fj_spawn_num         = 0
  fj_difficulty        = 0
  fj_delay             = 10
  fj_method            = 0
  fj_duration          = 1000
  fj_wander_dist_spawn = 1000
  fj_mvmt_dist_spawn   = 1000
  fj_max_num           = 0
  fj_enable            = 1
  fj_day_prob          = 100
  fj_night_prob        = 100
  fj_spawn_freq        = 0
  fj_countdown         = 0
  fj_weight0           = 0
  fj_weight1           = 0
  fj_weight2           = 0
  fj_weight3           = 0
  fj_weight4           = 0
  fj_weight5           = 0
  fj_weight6           = 0
  fj_weight7           = 0
  fj_weight8           = 0
  fj_weight9           = 0

  // containers
  fj_lock_diff         = 100
  fj_trap_remove_diff  = 100
  fj_trap_loc_x        = 0
  fj_trap_loc_y        = 0
  fj_lockpick_strref   = ` 0

  // items
  fj_con_itm_idx       = ` 0
  fj_itm_expiry        = 0
  fj_charge0           = 0
  fj_charge1           = 0
  fj_charge2           = 0

  // ambients
  fj_radius            = 500
  fj_loc_z             = 0
  fj_pitch_variance    = 0
  fj_volume_variance   = 0
  fj_volume            = 80
  fj_sound_num         = 0
  fj_delay             = 0
  fj_variation         = 0

  // variables
  fj_variable_value    = 0

  // doors
  fj_open_box_left     = 0
  fj_open_box_top      = 0
  fj_open_box_right    = 0
  fj_open_box_bottom   = 0
  fj_closed_box_left   = 0
  fj_closed_box_top    = 0
  fj_closed_box_right  = 0
  fj_closed_box_bottom = 0
  fj_detect_diff       = 0
  fj_locked_diff       = 0
  fj_open_loc_x        = 0
  fj_open_loc_y        = 0
  fj_closed_loc_x      = 0
  fj_closed_loc_y      = 0
  fj_dlg_strref        = ` 0

  // animations
  fj_bam_seq           = 0
  fj_bam_frame         = 0
  fj_transparent       = 0
  fj_init_frame        = 0
  fj_loop_chance       = 0
  fj_skip_cycles       = 0
  fj_width             = 0
  fj_height            = 0

  // songs
  fj_song_day          = 0
  fj_song_night        = 0
  fj_song_victory      = 0
  fj_song_battle       = 0
  fj_song_defeat       = 0
  fj_song_day_alt      = ` 0
  fj_song_night_alt    = ` 0
  fj_song_victory_alt  = ` 0
  fj_song_battle_alt   = ` 0
  fj_song_defeat_alt   = ` 0
  fj_song_day_vol      = 100
  fj_song_night_vol    = 100
  fj_song_reverb       = 0

  // rest interrupts
  fj_cre_strref0       = ` 0
  fj_cre_strref1       = ` 0
  fj_cre_strref2       = ` 0
  fj_cre_strref3       = ` 0
  fj_cre_strref4       = ` 0
  fj_cre_strref5       = ` 0
  fj_cre_strref6       = ` 0
  fj_cre_strref7       = ` 0
  fj_cre_strref8       = ` 0
  fj_cre_strref9       = ` 0
  fj_duration          = 1000
  fj_wander_distance   = 1000
  fj_mvmt_distance     = 1000
  fj_day_prob          = 100
  fj_night_prob        = 100

  // map notes
  fj_note_strref       = ` 0
  fj_strref_loc        = 1
  fj_color             = 0
  fj_note_id           = 0

  // embedded projectiles
  fj_missile_num       = ` 0
  fj_frequency         = 0
  fj_target            = 0
  fj_creator           = 0

  STR_VAR

  // variables
  fj_structure_type    = ~~
  fj_name              = ~~

  // actors
  fj_dlg_resref        = ~~
  fj_bcs_override      = ~~
  fj_bcs_general       = ~~
  fj_bcs_class         = ~~
  fj_bcs_race          = ~~
  fj_bcs_default       = ~~
  fj_bcs_specific      = ~~
  fj_cre_resref        = ~~
  fj_cre_embedded      = ~~

  // regions
  fj_destination_area  = ~~
  fj_destination_name  = ~~
  fj_key_resref        = ~~
  fj_reg_script        = ~~
  fj_sound             = ~~ // only for PST
  fj_dialog            = ~~ // only for PST

  // spawns
  fj_cre_resref0       = ~~
  fj_cre_resref1       = ~~
  fj_cre_resref2       = ~~
  fj_cre_resref3       = ~~
  fj_cre_resref4       = ~~
  fj_cre_resref5       = ~~
  fj_cre_resref6       = ~~
  fj_cre_resref7       = ~~
  fj_cre_resref8       = ~~
  fj_cre_resref9       = ~~

  // containers
  fj_trap_script       = ~~

  // ambients
  fj_wav_resref0       = ~~
  fj_wav_resref1       = ~~
  fj_wav_resref2       = ~~
  fj_wav_resref3       = ~~
  fj_wav_resref4       = ~~
  fj_wav_resref5       = ~~
  fj_wav_resref6       = ~~
  fj_wav_resref7       = ~~
  fj_wav_resref8       = ~~
  fj_wav_resref9       = ~~

  // doors
  fj_door_wed_id       = ~~
  fj_door_open_wav     = ~~
  fj_door_close_wav    = ~~
  fj_door_script       = ~~
  fj_travel_trigger    = ~~

  // animations
  fj_bam_resref        = ~~
  fj_bmp_resref        = ~~

  //bitmask
  fj_bitmask           = ~~

  // songs
  fj_song_day0         = ~~
  fj_song_day1         = ~~
  fj_song_night0       = ~~
  fj_song_night1       = ~~

  // map notes
  fj_note_text         = ~~ // only for PST

  RET
  fj_return_offset

BEGIN

// we must set $num(0) == num_0 when using function input
// otherwise WeiDU won\'t recognize that they\'re synonymous
PATCH_FOR_EACH value IN
  vertex door_open_vert door_closed_vert cell_open_vert cell_closed_vert
BEGIN
  FOR( num = 0 ; VARIABLE_IS_SET EVAL ~fj_%value%_%num%~ ; ++num )BEGIN
    SET $EVAL ~fj_%value%~(~%num%~) = EVAL ~fj_%value%_%num%~
  END
END
FOR( num = 0 ; VARIABLE_IS_SET EVAL ~fj_embedded_eff_%num%~ ; ++num )BEGIN
  TEXT_SPRINT $fj_embedded_eff(~%num%~) EVAL ~%fj_embedded_eff_%num%%~
END

// php over this array rather than an explicit list to reduce code length and typos
CLEAR_ARRAY struct
TEXT_SPRINT $struct(0x54 0x58 0x02 0x110) actor
TEXT_SPRINT $struct(0x5c 0x5a 0x02 0x0c4) region
TEXT_SPRINT $struct(0x60 0x64 0x04 0x0c8) spawn
TEXT_SPRINT $struct(0x68 0x6c 0x04 0x068) entrance
TEXT_SPRINT $struct(0x70 0x74 0x02 0x0c0) container
TEXT_SPRINT $struct(0x78 0x76 0x02 0x014) itm
TEXT_SPRINT $struct(0x84 0x82 0x02 0x0d4) ambient
TEXT_SPRINT $struct(0x88 0x8c 0x02 0x054) variable
TEXT_SPRINT $struct(0xa8 0xa4 0x04 0x0c8) door
TEXT_SPRINT $struct(0xb8 0xb4 0x04 0x06c) tiled
TEXT_SPRINT $struct(0x7c 0x80 0x02 0x004) vertex
TEXT_SPRINT $struct(0xb0 0xac 0x04 0x04c) animation
TEXT_SPRINT $struct(0xa0 0x9c 0x04 0x000) bitmask
TEXT_SPRINT $struct(0xbc 0x00 0x00 0x090) songs
TEXT_SPRINT $struct(0xc0 0x00 0x00 0x0e4) interrupts
PATCH_IF is_pst BEGIN
  TEXT_SPRINT $struct(0xc8 0xcc 0x04 0x214) note
END ELSE BEGIN
  TEXT_SPRINT $struct(0xc4 0xc8 0x04 0x034) note
  TEXT_SPRINT $struct(0xcc 0xd0 0x04 0x01c) projectile
END
PHP_EACH struct AS key => value BEGIN
  PATCH_IF ~%value%~ STRING_EQUAL_CASE ~%fj_structure_type%~ BEGIN
    SET fj_structure_type = key_0
  END
END

// Icewind Dale II decided to be uselessly special
PATCH_IF is_id2 BEGIN
  READ_ASCII   0x54 id2_header (0x10)
  DELETE_BYTES 0x54 0x10
  PATCH_FOR_EACH off IN
    0x54 0x5c 0x60 0x68 0x70 0x78 0x7c 0x84 0x88 0xa0 0xa8 0xb0 0xb8 0xbc 0xc0
  BEGIN
    PATCH_IF LONG_AT off BEGIN
      WRITE_LONG off THIS - 0x10
    END
  END
END

PATCH_IF fj_unzero_header_off BEGIN

  // a small courtesy to fix areas missing obligatory structures
  PATCH_IF fj_delete_mode == ` 0 BEGIN
    PATCH_IF !LONG_AT 0xbc && fj_structure_type != 0xbc BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Offset to songlist points to 0! Adding empty songlist.~ END
      WRITE_LONG 0xbc BUFFER_LENGTH
      INSERT_BYTES BUFFER_LENGTH 0x90
    END
    PATCH_IF !LONG_AT 0xc0 && fj_structure_type != 0xc0 BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Offset to rest interrupts points to 0! Adding empty rest interrupt table.~ END
      WRITE_LONG 0xc0 BUFFER_LENGTH
      INSERT_BYTES BUFFER_LENGTH 0xe4
    END
  END

  // offsets to valid structures should not point to 0
  PATCH_FOR_EACH off IN
    0x54 0x5c 0x60 0x68 0x70 0x78 0x7c 0x84 0x88 0xa0 0xa8 0xb0 0xb8
  BEGIN
    PATCH_IF !LONG_AT off BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Header offset %off% points to 0, setting to 0x11c.~ END
      WRITE_LONG off 0x11c
    END
  END
  PATCH_IF is_pst BEGIN
    PATCH_IF !LONG_AT 0xc8 BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Header offset 0xc8 points to 0, setting to 0x11c.~ END
      WRITE_LONG 0xc8 0x11c
    END
  END ELSE PATCH_IF is_bg2 BEGIN
    PATCH_FOR_EACH off IN 0xc4 0xcc BEGIN
      PATCH_IF !LONG_AT off BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Header offset %off% points to 0, setting to 0x11c.~ END
        WRITE_LONG off 0x11c
      END
    END
  END

END

// long block to read all the existing data
PATCH_IF fj_debug BEGIN PATCH_PRINT ~Beginning unmarshalling.~ END
PHP_EACH struct AS key => value BEGIN
  PATCH_IF( LONG_AT key_0 )BEGIN // skip it if the header offset points at 0
    CLEAR_ARRAY EVAL ~%value%~
    GET_OFFSET_ARRAY EVAL ~%value%~ key_0 0x04 key_1 key_2 0x00 0x00 key_3 // e.g. $region
    PHP_EACH ~%value%~ AS num => off BEGIN
      CLEAR_ARRAY array

      PATCH_IF( key_0 == 0x54 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading actor %num%.~ END
        PATCH_IF!( LONG_AT (off + 0x28) & 0x01 )BEGIN
          PATCH_IF fj_debug BEGIN PATCH_PRINT ~  Associating embedded creature.~ END
          READ_ASCII LONG_AT (off + 0x88) $are_embedded_cre(~%num%~) (LONG_AT (off + 0x8c))
        END
        WRITE_LONG off + 0x88 0
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0x5c )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading region %num%.~ END
        PATCH_IF( fj_debug && SHORT_AT ( off + 0x2a ) )BEGIN PATCH_PRINT ~  Associating vertices.~ END
        GET_OFFSET_ARRAY2 array off ARE_V10_REGION_VERTICES
        PHP_EACH array AS num1 => off1 BEGIN
          READ_LONG off1 $EVAL ~are_region_%num%_vertex~(~%num1%~)
        END
        CLEAR_ARRAY array
        WRITE_LONG off + 0x2c 0x00
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0x60 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading spawn %num%~ END
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0x68 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading entrance %num%~ END
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0x70 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading container %num%.~ END

        // load container vertices
        GET_OFFSET_ARRAY2 array off ARE_V10_CONTAINER_VERTICES
        PATCH_IF( fj_debug && LONG_AT ( off + 0x54 ) )BEGIN PATCH_PRINT ~  Associating vertices.~ END
        PHP_EACH array AS num1 => off1 BEGIN
          READ_LONG off1 $EVAL ~are_container_%num%_vertex~(~%num1%~)
        END
        CLEAR_ARRAY array

        // load container items
        GET_OFFSET_ARRAY2 array off ARE_V10_ITEMS
        PATCH_IF( fj_debug && LONG_AT ( off + 0x44 ) )BEGIN PATCH_PRINT ~  Associating items.~ END
        PHP_EACH array AS num1 => off1 BEGIN
          READ_ASCII off1 $EVAL ~are_container_%num%_itm~(~%num1%~) (0x14)
        END
        CLEAR_ARRAY array

        // read container structure
        WRITE_LONG off + 0x40 0x00 // wipe item index
        WRITE_LONG off + 0x44 0x00 // wipe item count
        WRITE_LONG off + 0x50 0x00 // wipe vertex index
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      // items are read off with their associated containers
      PATCH_IF( key_0 == 0x78 )BEGIN
      END ELSE

      PATCH_IF( key_0 == 0x84 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading ambient %num%~ END
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0x88 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading variable %num%~ END
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0xa8 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading door %num% and associated vertices.~ END
        // load door open vertices
        GET_OFFSET_ARRAY2 array off ARE_V10_DOOR_OPEN_OUTLINE_VERTICES
        PHP_EACH array AS num1 => off1 BEGIN
          READ_LONG off1 $EVAL ~are_door_open_%num%_vertex~(~%num1%~)
        END
        CLEAR_ARRAY array
        WRITE_LONG off + 0x2c 0x00
        // load door closed vertices
        GET_OFFSET_ARRAY2 array off ARE_V10_DOOR_CLOSED_OUTLINE_VERTICES
        PHP_EACH array AS num1 => off1 BEGIN
          READ_LONG off1 $EVAL ~are_door_closed_%num%_vertex~(~%num1%~)
        END
        CLEAR_ARRAY array
        WRITE_LONG off + 0x34 0x00
        // load cell open vertices
        GET_OFFSET_ARRAY2 array off ARE_V10_DOOR_OPEN_CELL_VERTICES
        PHP_EACH array AS num1 => off1 BEGIN
          READ_LONG off1 $EVAL ~are_cell_open_%num%_vertex~(~%num1%~)
        END
        CLEAR_ARRAY array
        WRITE_LONG off + 0x48 0x00
        // load cell closed vertices
        GET_OFFSET_ARRAY2 array off ARE_V10_DOOR_CLOSED_CELL_VERTICES
        PHP_EACH array AS num1 => off1 BEGIN
          READ_LONG off1 $EVAL ~are_cell_closed_%num%_vertex~(~%num1%~)
        END
        CLEAR_ARRAY array
        WRITE_LONG off + 0x50 0x00
        // read the door structure itself
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0xb8 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading tiled object %num% (something is probably very wrong).~ END
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      // vertices, these are read off with their associated regions/containers/doors
      PATCH_IF( key_0 == 0x78 )BEGIN
      END ELSE

      PATCH_IF( key_0 == 0xb0 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading animation %num%.~ END
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF(
        ( key_0 == 0xc4 && is_bg2 ) ||
        ( key_0 == 0xc8 && is_pst)
      )BEGIN //
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading map note %num%.~ END
        READ_ASCII off $EVAL ~are_%value%~(~%num%~) (key_3)
      END ELSE

      PATCH_IF( key_0 == 0xcc && is_bg2 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading projectile %num%.~ END
        READ_ASCII off $are_projectile(~%num%~) (key_3)
        PATCH_IF SHORT_AT (off + 0x0c) BEGIN
          PATCH_IF( fj_debug )BEGIN PATCH_PRINT ~  Associating v2 embedded effects.~ END
          READ_ASCII LONG_AT (off + 0x08) $are_embedded_eff(~%num%~) (SHORT_AT (off + 0x0c))
        END
      END

    END // php_each ~%value%~
    CLEAR_ARRAY array
    CLEAR_ARRAY EVAL ~%value%~

    // single structures

    // bitmask
    PATCH_IF( key_0 == 0xa0 )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading bitmask (should only exist in saved game areas).~ END
      READ_ASCII LONG_AT 0xa0 $are_bitmask(0) (LONG_AT 0x9c)
    END ELSE

    // songs
    PATCH_IF( key_0 == 0xbc )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading songs (obligatory structure).~ END
      READ_ASCII LONG_AT 0xbc $are_songs(0) (0x90)
    END ELSE

    // rest interrupts
    PATCH_IF( key_0 == 0xc0 )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reading rest interrupt table (obligatory structure).~ END
      READ_ASCII LONG_AT 0xc0 $are_interrupts(0) (0xe4)
    END

  END // skip if key_0 points to 0
END // end php_each $structure: all extended structures now loaded in buffer

PATCH_IF fj_debug BEGIN PATCH_PRINT ~Trimming %SOURCE_FILE% down to the header.~ END
DELETE_BYTES 0x11c BUFFER_LENGTH - 0x11c
PHP_EACH struct AS key => value BEGIN
  PATCH_IF( key_2 == 0x02 )BEGIN
    WRITE_SHORT key_1 0x00
  END ELSE
  PATCH_IF( key_2 == 0x04 )BEGIN
    WRITE_LONG  key_1 0x00
  END
END

PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reassembling %SOURCE_FILE%.~ END
PHP_EACH struct AS key => value BEGIN
  WRITE_LONG key_0 fj_position
  PHP_EACH ~are_%value%~ AS key1 => value1 BEGIN
    PATCH_IF( key_0 != 0xa0 && key_0 != 0xbc && key_0 != 0xc0 )BEGIN
      PATCH_IF( key1 != fj_delete_mode || fj_structure_type != key_0 )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reinserting %value% number %key1%.~ END
        PATCH_IF( key_2 == 0x02 )BEGIN
          WRITE_SHORT key_1 THIS + 0x01
        END ELSE
        PATCH_IF( key_2 == 0x04 )BEGIN
          WRITE_LONG  key_1 THIS + 0x01
        END
        INSERT_BYTES fj_position key_3
        WRITE_ASCIIE fj_position ~%value1%~
        SET fj_position += key_3
      END
    END ELSE
    PATCH_IF( key_0 == 0xa0 && fj_structure_type != key_0 )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reinserting %value% number %key1%.~ END
      TEXT_SPRINT  value1      $are_bitmask(0)
      WRITE_LONG   0x9c        STRING_LENGTH EVAL ~%value1%~
      INSERT_BYTES fj_position LONG_AT 0x9c
      WRITE_ASCIIE fj_position ~%value1%~
      SET fj_position += LONG_AT 0x9c
    END ELSE
    PATCH_IF( key_0 == 0xbc && fj_structure_type != key_0 )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reinserting %value% number %key1%.~ END
      INSERT_BYTES fj_position key_3
      WRITE_ASCIIE fj_position ~%value1%~
      SET fj_position += key_3
    END ELSE
    PATCH_IF( key_0 == 0xc0 && fj_structure_type != key_0 )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reinserting %value% number %key1%.~ END
      INSERT_BYTES fj_position key_3
      WRITE_ASCIIE fj_position ~%value1%~
      SET fj_position += key_3
    END
  END // PHP_EACH $EVAL ~are_%value%~

  // add new structure
  PATCH_IF( key_0 == fj_structure_type && fj_delete_mode == ` 0 && key_0 != 0x78 )BEGIN
    PATCH_IF fj_debug BEGIN PATCH_PRINT ~Adding new %value% structure.~ END
    PATCH_IF( key_2 == 0x02 )BEGIN
      WRITE_SHORT key_1 THIS + 0x01
    END ELSE PATCH_IF( key_2 == 0x04 )BEGIN
      WRITE_LONG  key_1 THIS + 0x01
    END
    SET fj_return_offset = fj_position
    INSERT_BYTES fj_position key_3
    SET fj_position += key_3

    // actor
    PATCH_IF( fj_structure_type == 0x54 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_SHORT  fj_return_offset + 0x20 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x22 fj_loc_y
      WRITE_SHORT  fj_return_offset + 0x24 fj_dest_x
      WRITE_SHORT  fj_return_offset + 0x26 fj_dest_y
      WRITE_LONG   fj_return_offset + 0x28 fj_loading
      WRITE_LONG   fj_return_offset + 0x2c fj_spawned
      WRITE_LONG   fj_return_offset + 0x30 fj_animation
      WRITE_LONG   fj_return_offset + 0x34 fj_orientation
      WRITE_LONG   fj_return_offset + 0x38 fj_expiry
      WRITE_SHORT  fj_return_offset + 0x3c fj_wander_dist_actor
      WRITE_SHORT  fj_return_offset + 0x3e fj_mvmt_dist_actor
      WRITE_LONG   fj_return_offset + 0x40 fj_schedule
      WRITE_LONG   fj_return_offset + 0x44 fj_num_talked
      WRITE_ASCIIE fj_return_offset + 0x48 ~%fj_dlg_resref%~ #8
      WRITE_ASCIIE fj_return_offset + 0x50 ~%fj_bcs_override%~ #8
      WRITE_ASCIIE fj_return_offset + 0x58 ~%fj_bcs_general%~ #8
      WRITE_ASCIIE fj_return_offset + 0x60 ~%fj_bcs_class%~ #8
      WRITE_ASCIIE fj_return_offset + 0x68 ~%fj_bcs_race%~ #8
      WRITE_ASCIIE fj_return_offset + 0x70 ~%fj_bcs_default%~ #8
      WRITE_ASCIIE fj_return_offset + 0x78 ~%fj_bcs_specific%~ #8
      WRITE_ASCIIE fj_return_offset + 0x80 ~%fj_cre_resref%~ #8
    END ELSE

    // region
    PATCH_IF( fj_structure_type == 0x5c )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_SHORT  fj_return_offset + 0x20 fj_type
      WRITE_SHORT  fj_return_offset + 0x22 fj_box_left
      WRITE_SHORT  fj_return_offset + 0x24 fj_box_top
      WRITE_SHORT  fj_return_offset + 0x26 fj_box_right
      WRITE_SHORT  fj_return_offset + 0x28 fj_box_bottom
      WRITE_LONG   fj_return_offset + 0x34 fj_cursor_idx
      WRITE_ASCIIE fj_return_offset + 0x38 ~%fj_destination_area%~ #8
      WRITE_ASCIIE fj_return_offset + 0x40 ~%fj_destination_name%~ #32
      WRITE_LONG   fj_return_offset + 0x60 fj_flags
      WRITE_LONG   fj_return_offset + 0x64 fj_info_point_strref
      WRITE_SHORT  fj_return_offset + 0x68 fj_trap_detect
      WRITE_SHORT  fj_return_offset + 0x6a fj_trap_remove
      WRITE_SHORT  fj_return_offset + 0x6c fj_trap_active
      WRITE_SHORT  fj_return_offset + 0x6e fj_trap_status
      WRITE_SHORT  fj_return_offset + 0x70 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x72 fj_loc_y
      WRITE_ASCIIE fj_return_offset + 0x74 ~%fj_key_resref%~ #8
      WRITE_ASCIIE fj_return_offset + 0x7c ~%fj_reg_script%~ #8
      WRITE_SHORT  fj_return_offset + 0x84 fj_alt_x
      WRITE_SHORT  fj_return_offset + 0x86 fj_alt_y
      WRITE_ASCIIE fj_return_offset + 0xac ~%fj_sound%~ #8
      WRITE_SHORT  fj_return_offset + 0xb4 fj_talk_loc_x
      WRITE_SHORT  fj_return_offset + 0xb6 fj_talk_loc_y
      WRITE_LONG   fj_return_offset + 0xb8 fj_speaker_strref
      WRITE_ASCIIE fj_return_offset + 0xbc ~%fj_dialog%~ #8
      PHP_EACH fj_vertex AS key1 => value1 BEGIN
        WRITE_SHORT fj_return_offset + 0x2a THIS + 0x01
      END
    END ELSE

    // spawn
    PATCH_IF( fj_structure_type == 0x60 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_SHORT  fj_return_offset + 0x20 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x22 fj_loc_y
      WRITE_ASCIIE fj_return_offset + 0x24 ~%fj_cre_resref0%~ #8
      WRITE_ASCIIE fj_return_offset + 0x2c ~%fj_cre_resref1%~ #8
      WRITE_ASCIIE fj_return_offset + 0x34 ~%fj_cre_resref2%~ #8
      WRITE_ASCIIE fj_return_offset + 0x3c ~%fj_cre_resref3%~ #8
      WRITE_ASCIIE fj_return_offset + 0x44 ~%fj_cre_resref4%~ #8
      WRITE_ASCIIE fj_return_offset + 0x4c ~%fj_cre_resref5%~ #8
      WRITE_ASCIIE fj_return_offset + 0x54 ~%fj_cre_resref6%~ #8
      WRITE_ASCIIE fj_return_offset + 0x5c ~%fj_cre_resref7%~ #8
      WRITE_ASCIIE fj_return_offset + 0x64 ~%fj_cre_resref8%~ #8
      WRITE_ASCIIE fj_return_offset + 0x6c ~%fj_cre_resref9%~ #8
      WRITE_SHORT  fj_return_offset + 0x74 fj_spawn_num
      WRITE_SHORT  fj_return_offset + 0x76 fj_difficulty
      WRITE_SHORT  fj_return_offset + 0x78 fj_delay
      WRITE_SHORT  fj_return_offset + 0x7a fj_method
      WRITE_LONG   fj_return_offset + 0x7c fj_duration
      WRITE_SHORT  fj_return_offset + 0x80 fj_wander_dist_spawn
      WRITE_SHORT  fj_return_offset + 0x82 fj_mvmt_dist_spawn
      WRITE_SHORT  fj_return_offset + 0x84 fj_max_num
      WRITE_SHORT  fj_return_offset + 0x86 fj_enable
      WRITE_LONG   fj_return_offset + 0x88 fj_schedule
      WRITE_SHORT  fj_return_offset + 0x8c fj_day_prob
      WRITE_SHORT  fj_return_offset + 0x8e fj_night_prob
      WRITE_LONG   fj_return_offset + 0x90 fj_spawn_freq
      WRITE_LONG   fj_return_offset + 0x94 fj_countdown
      WRITE_BYTE   fj_return_offset + 0x98 fj_weight0
      WRITE_BYTE   fj_return_offset + 0x99 fj_weight1
      WRITE_BYTE   fj_return_offset + 0x9a fj_weight2
      WRITE_BYTE   fj_return_offset + 0x9b fj_weight3
      WRITE_BYTE   fj_return_offset + 0x9c fj_weight4
      WRITE_BYTE   fj_return_offset + 0x9d fj_weight5
      WRITE_BYTE   fj_return_offset + 0x9e fj_weight6
      WRITE_BYTE   fj_return_offset + 0x9f fj_weight7
      WRITE_BYTE   fj_return_offset + 0xa0 fj_weight8
      WRITE_BYTE   fj_return_offset + 0xa1 fj_weight9
    END ELSE

    // entrance
    PATCH_IF( fj_structure_type == 0x68 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_SHORT  fj_return_offset + 0x20 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x22 fj_loc_y
      WRITE_SHORT  fj_return_offset + 0x24 fj_orientation
    END ELSE

    // container
    PATCH_IF( fj_structure_type == 0x70 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_SHORT  fj_return_offset + 0x20 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x22 fj_loc_y
      WRITE_SHORT  fj_return_offset + 0x24 fj_type
      WRITE_SHORT  fj_return_offset + 0x26 fj_lock_diff
      WRITE_LONG   fj_return_offset + 0x28 fj_flags
      WRITE_SHORT  fj_return_offset + 0x2c fj_trap_detect
      WRITE_SHORT  fj_return_offset + 0x2e fj_trap_remove_diff
      WRITE_SHORT  fj_return_offset + 0x30 fj_trap_active
      WRITE_SHORT  fj_return_offset + 0x32 fj_trap_status
      WRITE_SHORT  fj_return_offset + 0x34 fj_trap_loc_x
      WRITE_SHORT  fj_return_offset + 0x36 fj_trap_loc_y
      WRITE_SHORT  fj_return_offset + 0x38 fj_box_left
      WRITE_SHORT  fj_return_offset + 0x3a fj_box_top
      WRITE_SHORT  fj_return_offset + 0x3c fj_box_right
      WRITE_SHORT  fj_return_offset + 0x3e fj_box_bottom
      WRITE_ASCIIE fj_return_offset + 0x48 ~%fj_trap_script%~ #8
      WRITE_ASCIIE fj_return_offset + 0x78 ~%fj_key_resref%~ #8
      WRITE_LONG   fj_return_offset + 0x84 fj_lockpick_strref
      PHP_EACH fj_vertex AS key1 => value1 BEGIN
        WRITE_LONG fj_return_offset + 0x54 THIS + 0x01
      END
    END ELSE

    // ambient
    PATCH_IF( fj_structure_type == 0x84 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_SHORT  fj_return_offset + 0x20 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x22 fj_loc_y
      WRITE_SHORT  fj_return_offset + 0x24 fj_radius
      WRITE_SHORT  fj_return_offset + 0x26 fj_loc_z
      WRITE_LONG   fj_return_offset + 0x28 fj_pitch_variance
      WRITE_SHORT  fj_return_offset + 0x2c fj_volume_variance
      WRITE_SHORT  fj_return_offset + 0x2e fj_volume
      WRITE_ASCIIE fj_return_offset + 0x30 ~%fj_wav_resref0%~ #8
      WRITE_ASCIIE fj_return_offset + 0x38 ~%fj_wav_resref1%~ #8
      WRITE_ASCIIE fj_return_offset + 0x40 ~%fj_wav_resref2%~ #8
      WRITE_ASCIIE fj_return_offset + 0x48 ~%fj_wav_resref3%~ #8
      WRITE_ASCIIE fj_return_offset + 0x50 ~%fj_wav_resref4%~ #8
      WRITE_ASCIIE fj_return_offset + 0x58 ~%fj_wav_resref5%~ #8
      WRITE_ASCIIE fj_return_offset + 0x60 ~%fj_wav_resref6%~ #8
      WRITE_ASCIIE fj_return_offset + 0x68 ~%fj_wav_resref7%~ #8
      WRITE_ASCIIE fj_return_offset + 0x70 ~%fj_wav_resref8%~ #8
      WRITE_ASCIIE fj_return_offset + 0x78 ~%fj_wav_resref9%~ #8
      WRITE_SHORT  fj_return_offset + 0x80 fj_sound_num
      WRITE_LONG   fj_return_offset + 0x84 fj_delay
      WRITE_LONG   fj_return_offset + 0x88 fj_variation
      WRITE_LONG   fj_return_offset + 0x8c fj_schedule
      WRITE_LONG   fj_return_offset + 0x90 fj_flags
    END ELSE

    // variable
    PATCH_IF( fj_structure_type == 0x88 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_LONG   fj_return_offset + 0x28 fj_variable_value
    END ELSE

    // door
    PATCH_IF( fj_structure_type == 0xa8 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_ASCIIE fj_return_offset + 0x20 ~%fj_door_wed_id%~ #8
      WRITE_LONG   fj_return_offset + 0x28 fj_flags
      WRITE_SHORT  fj_return_offset + 0x38 fj_open_box_left
      WRITE_SHORT  fj_return_offset + 0x3a fj_open_box_top
      WRITE_SHORT  fj_return_offset + 0x3c fj_open_box_right
      WRITE_SHORT  fj_return_offset + 0x3e fj_open_box_bottom
      WRITE_SHORT  fj_return_offset + 0x40 fj_closed_box_left
      WRITE_SHORT  fj_return_offset + 0x42 fj_closed_box_top
      WRITE_SHORT  fj_return_offset + 0x44 fj_closed_box_right
      WRITE_SHORT  fj_return_offset + 0x46 fj_closed_box_bottom
      WRITE_ASCIIE fj_return_offset + 0x58 ~%fj_door_open_wav%~ #8
      WRITE_ASCIIE fj_return_offset + 0x60 ~%fj_door_close_wav%~ #8
      WRITE_LONG   fj_return_offset + 0x68 fj_cursor_idx
      WRITE_SHORT  fj_return_offset + 0x6c fj_trap_detect
      WRITE_SHORT  fj_return_offset + 0x6e fj_trap_remove
      WRITE_SHORT  fj_return_offset + 0x70 fj_trap_active
      WRITE_SHORT  fj_return_offset + 0x72 fj_trap_status
      WRITE_SHORT  fj_return_offset + 0x74 fj_trap_loc_x
      WRITE_SHORT  fj_return_offset + 0x76 fj_trap_loc_y
      WRITE_ASCIIE fj_return_offset + 0x78 ~%fj_key_resref%~ #8
      WRITE_ASCIIE fj_return_offset + 0x80 ~%fj_door_script%~ #8
      WRITE_LONG   fj_return_offset + 0x88 fj_detect_diff
      WRITE_LONG   fj_return_offset + 0x8c fj_locked_diff
      WRITE_SHORT  fj_return_offset + 0x90 fj_open_loc_x
      WRITE_SHORT  fj_return_offset + 0x92 fj_open_loc_y
      WRITE_SHORT  fj_return_offset + 0x94 fj_closed_loc_x
      WRITE_SHORT  fj_return_offset + 0x96 fj_closed_loc_y
      WRITE_LONG   fj_return_offset + 0x98 fj_lockpick_strref
      WRITE_ASCIIE fj_return_offset + 0x9c ~%fj_travel_trigger%~ #24
      WRITE_LONG   fj_return_offset + 0xb4 fj_dlg_strref
      WRITE_ASCIIE fj_return_offset + 0xb8 ~%fj_dlg_resref%~ #8
      PHP_EACH fj_door_open_vert   AS key1 => value1 BEGIN
        WRITE_SHORT fj_return_offset + 0x30 THIS + 0x01
      END
      PHP_EACH fj_door_closed_vert AS key1 => value1 BEGIN
        WRITE_SHORT fj_return_offset + 0x32 THIS + 0x01
      END
      PHP_EACH fj_cell_open_vert   AS key1 => value1 BEGIN
        WRITE_SHORT fj_return_offset + 0x4c THIS + 0x01
      END
      PHP_EACH fj_cell_closed_vert AS key1 => value1 BEGIN
        WRITE_SHORT fj_return_offset + 0x4e THIS + 0x01
      END
    END ELSE

    // animation
    PATCH_IF( fj_structure_type == 0xb0 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_SHORT  fj_return_offset + 0x20 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x22 fj_loc_y
      WRITE_LONG   fj_return_offset + 0x24 fj_schedule
      WRITE_ASCIIE fj_return_offset + 0x28 ~%fj_bam_resref%~ #8
      WRITE_SHORT  fj_return_offset + 0x30 fj_bam_seq
      WRITE_SHORT  fj_return_offset + 0x32 fj_bam_frame
      WRITE_LONG   fj_return_offset + 0x34 fj_flags
      WRITE_SHORT  fj_return_offset + 0x38 fj_loc_z
      WRITE_SHORT  fj_return_offset + 0x3a fj_transparent
      WRITE_SHORT  fj_return_offset + 0x3c fj_init_frame
      WRITE_BYTE   fj_return_offset + 0x3e fj_loop_chance
      WRITE_BYTE   fj_return_offset + 0x3f fj_skip_cycles
      WRITE_ASCIIE fj_return_offset + 0x40 ~%fj_bmp_resref%~ #8
      WRITE_SHORT  fj_return_offset + 0x48 fj_width
      WRITE_SHORT  fj_return_offset + 0x4a fj_height
    END ELSE

    // bitmask
    PATCH_IF( fj_structure_type == 0xa0 )BEGIN
      PATCH_IF( FILE_EXISTS ~%fj_bitmask%~ )BEGIN
        SET key1 = BUFFER_LENGTH
        APPEND_FILE_EVALUATE ~%fj_bitmask%~
        WRITE_LONG 0x9c BUFFER_LENGTH - key1
      END ELSE BEGIN
        WRITE_LONG 0x9c 0x00
      END
      SET fj_position += LONG_AT 0x9c
    END ELSE

    // songs
    PATCH_IF( fj_structure_type == 0xbc )BEGIN
      WRITE_LONG   fj_return_offset + 0x00 fj_song_day
      WRITE_LONG   fj_return_offset + 0x04 fj_song_night
      WRITE_LONG   fj_return_offset + 0x08 fj_song_victory
      WRITE_LONG   fj_return_offset + 0x0c fj_song_battle
      WRITE_LONG   fj_return_offset + 0x10 fj_song_defeat
      WRITE_LONG   fj_return_offset + 0x14 fj_song_day_alt
      WRITE_LONG   fj_return_offset + 0x18 fj_song_night_alt
      WRITE_LONG   fj_return_offset + 0x1c fj_song_victory_alt
      WRITE_LONG   fj_return_offset + 0x20 fj_song_battle_alt
      WRITE_LONG   fj_return_offset + 0x24 fj_song_defeat_alt
      WRITE_ASCIIE fj_return_offset + 0x28 ~%fj_song_day0%~ #8
      WRITE_ASCIIE fj_return_offset + 0x30 ~%fj_song_day1%~ #8
      WRITE_LONG   fj_return_offset + 0x38 fj_song_day_vol
      WRITE_ASCIIE fj_return_offset + 0x3c ~%fj_song_night0%~ #8
      WRITE_ASCIIE fj_return_offset + 0x44 ~%fj_song_night1%~ #8
      WRITE_LONG   fj_return_offset + 0x4c fj_song_night_vol
      WRITE_LONG   fj_return_offset + 0x50 fj_song_reverb
    END ELSE

    // rest interrupts
    PATCH_IF( fj_structure_type == 0xc0 )BEGIN
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #32
      WRITE_LONG   fj_return_offset + 0x20 fj_cre_strref0
      WRITE_LONG   fj_return_offset + 0x24 fj_cre_strref1
      WRITE_LONG   fj_return_offset + 0x28 fj_cre_strref2
      WRITE_LONG   fj_return_offset + 0x2c fj_cre_strref3
      WRITE_LONG   fj_return_offset + 0x30 fj_cre_strref4
      WRITE_LONG   fj_return_offset + 0x34 fj_cre_strref5
      WRITE_LONG   fj_return_offset + 0x38 fj_cre_strref6
      WRITE_LONG   fj_return_offset + 0x3c fj_cre_strref7
      WRITE_LONG   fj_return_offset + 0x40 fj_cre_strref8
      WRITE_LONG   fj_return_offset + 0x44 fj_cre_strref9
      WRITE_ASCIIE fj_return_offset + 0x48 ~%fj_cre_resref0%~ #8
      WRITE_ASCIIE fj_return_offset + 0x50 ~%fj_cre_resref1%~ #8
      WRITE_ASCIIE fj_return_offset + 0x58 ~%fj_cre_resref2%~ #8
      WRITE_ASCIIE fj_return_offset + 0x60 ~%fj_cre_resref3%~ #8
      WRITE_ASCIIE fj_return_offset + 0x68 ~%fj_cre_resref4%~ #8
      WRITE_ASCIIE fj_return_offset + 0x70 ~%fj_cre_resref5%~ #8
      WRITE_ASCIIE fj_return_offset + 0x78 ~%fj_cre_resref6%~ #8
      WRITE_ASCIIE fj_return_offset + 0x80 ~%fj_cre_resref7%~ #8
      WRITE_ASCIIE fj_return_offset + 0x88 ~%fj_cre_resref8%~ #8
      WRITE_ASCIIE fj_return_offset + 0x90 ~%fj_cre_resref9%~ #8
      WRITE_SHORT  fj_return_offset + 0x98 fj_spawn_num
      WRITE_SHORT  fj_return_offset + 0x9a fj_difficulty
      WRITE_LONG   fj_return_offset + 0x9c fj_duration
      WRITE_SHORT  fj_return_offset + 0xa0 fj_wander_distance
      WRITE_SHORT  fj_return_offset + 0xa2 fj_mvmt_distance
      WRITE_SHORT  fj_return_offset + 0xa4 fj_max_num
      WRITE_SHORT  fj_return_offset + 0xa6 fj_enable
      WRITE_SHORT  fj_return_offset + 0xa8 fj_day_prob
      WRITE_SHORT  fj_return_offset + 0xaa fj_night_prob
    END ELSE

    // map note (BGII)
    PATCH_IF( fj_structure_type == 0xc4 )BEGIN
      WRITE_SHORT  fj_return_offset + 0x00 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x02 fj_loc_y
      WRITE_LONG   fj_return_offset + 0x04 fj_note_strref
      WRITE_SHORT  fj_return_offset + 0x08 fj_strref_loc
      WRITE_SHORT  fj_return_offset + 0x0a fj_color
      WRITE_LONG   fj_return_offset + 0x0c fj_note_id
    END ELSE

    // map note (PST)
    PATCH_IF( fj_structure_type == 0xc8 )BEGIN
      WRITE_LONG   fj_return_offset + 0x000 fj_loc_x
      WRITE_LONG   fj_return_offset + 0x004 fj_loc_y
      WRITE_ASCIIE fj_return_offset + 0x008 ~%fj_note_text%~ #500
      WRITE_LONG   fj_return_offset + 0x1fc fj_color
    END ELSE

    // embedded projectile
    PATCH_IF( fj_structure_type == 0xcc )BEGIN
      PATCH_IF(  fj_missile_num == ` 0 )BEGIN
        SET fj_missile_num = IDS_OF_SYMBOL ( projectl ~%fj_name%~ )
        PATCH_IF( fj_missile_num > ` 0 )BEGIN
          SET fj_missile_num -= 0x01
        END
      END
      WRITE_ASCIIE fj_return_offset + 0x00 ~%fj_name%~ #8
      WRITE_SHORT  fj_return_offset + 0x0e fj_missile_num
      WRITE_SHORT  fj_return_offset + 0x10 fj_frequency
      WRITE_SHORT  fj_return_offset + 0x12 fj_duration
      WRITE_SHORT  fj_return_offset + 0x14 fj_loc_x
      WRITE_SHORT  fj_return_offset + 0x16 fj_loc_y
      WRITE_SHORT  fj_return_offset + 0x18 fj_loc_z
      WRITE_BYTE   fj_return_offset + 0x1a fj_target
      WRITE_BYTE   fj_return_offset + 0x1b fj_creator
    END

  END

  // add items and index to their containers
  PATCH_IF( key_0 == 0x78 )BEGIN
    /* Delete once, even if num1 + index equal the mode of a subsequent item */
    fl#fj_are_structure#itm#state = 1
    PHP_EACH are_container AS num => structure BEGIN
      PATCH_IF( fj_structure_type == 0x70 && num == fj_delete_mode && fj_deleted == 0x00 )BEGIN
        SET fj_deleted = 0x01
      END ELSE BEGIN
        WRITE_LONG LONG_AT 0x70 + 0xc0 * ( num - fj_deleted ) + 0x40 fj_itm_idx
        PHP_EACH ~are_container_%num%_itm~ AS num1 => value1 BEGIN
          PATCH_IF(
            ( fj_structure_type != 0x78 ) ||
            ( fj_delete_mode != num1 + LONG_AT ( LONG_AT 0x70 + 0xc0 * ( num - fj_deleted ) + 0x40 ) ||
              !fl#fj_are_structure#itm#state )
          )BEGIN
            PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reassociating item %num1% to container %num%.~ END
            WRITE_LONG LONG_AT 0x70 + 0xc0 * ( num - fj_deleted ) + 0x44 THIS + 0x01
            INSERT_BYTES fj_position 0x14
            WRITE_ASCIIE fj_position ~%value1%~
            WRITE_SHORT  0x76 THIS + 0x01
            SET ++ fj_itm_idx
            SET fj_position += key_3
          END ELSE fl#fj_are_structure#itm#state = 0
        END
      END
      PATCH_IF( fj_con_itm_idx == num && fj_structure_type == 0x78 )BEGIN
        READ_LONG LONG_AT 0x70 + 0xc0 * num + 0x44 cnt
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Adding new item to container %num%.~ END
        WRITE_LONG LONG_AT 0x70 + 0xc0 * num + 0x44 THIS + 0x01
        WRITE_SHORT  0x76 THIS + 0x01
        INSERT_BYTES fj_position key_3
        WRITE_ASCIIE fj_position + 0x00 ~%fj_name%~ #8
        WRITE_SHORT  fj_position + 0x08 fj_itm_expiry
        WRITE_SHORT  fj_position + 0x0a fj_charge0
        WRITE_SHORT  fj_position + 0x0c fj_charge1
        WRITE_SHORT  fj_position + 0x0e fj_charge2
        WRITE_LONG   fj_position + 0x10 fj_flags
        SET ++ fj_itm_idx
        SET fj_position  += key_3
      END
    END // php $are_container
    SET fj_deleted = 0x00
    PHP_EACH are_container AS key => value BEGIN
      CLEAR_ARRAY EVAL ~are_container_%key%_itm~
    END
  END
  // after existing and new items have been added, index new containers
  PATCH_IF( fj_structure_type == 0x70 && fj_delete_mode == ` 0 )BEGIN
    WRITE_LONG fj_return_offset + 0x40 fj_itm_idx
  END

  // add vertices
  PATCH_IF( key_0 == 0x7c )BEGIN

    // vertices associated with regions
    PHP_EACH are_region    AS num => structure BEGIN
      PATCH_IF( fj_structure_type == 0x5c && num == fj_delete_mode && fj_deleted == 0x00 )BEGIN
        SET fj_deleted = 0x01
      END ELSE BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reassociating vertices to region %num%.~ END
        WRITE_LONG LONG_AT 0x5c + 0xc4 * ( num - fj_deleted ) + 0x2c fj_vertex_idx
        PHP_EACH ~are_region_%num%_vertex~ AS num1 => value1 BEGIN
          INSERT_BYTES fj_position 0x04
          WRITE_LONG   fj_position value1
          WRITE_SHORT  0x80        THIS + 0x01
          SET ++fj_vertex_idx
          SET fj_position += key_3
        END
      END
    END
    SET fj_deleted = 0x00
    PATCH_IF( fj_structure_type == 0x5c && fj_delete_mode == ` 0 )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Adding vertices to new region.~ END
      WRITE_LONG fj_return_offset + 0x2c fj_vertex_idx
      PHP_EACH fj_vertex AS num => off BEGIN
        INSERT_BYTES fj_position 0x04
        WRITE_SHORT  0x80        THIS + 0x01
        SET ++fj_vertex_idx
      END
      PHP_EACH fj_vertex AS num => off BEGIN
        WRITE_LONG fj_position off
        SET fj_position += 0x04
      END
    END
    PHP_EACH are_region    AS num => structure BEGIN
      CLEAR_ARRAY EVAL ~are_region_%num%_vertex~
    END

    // vertices associated with containers
    PHP_EACH are_container AS num => structure BEGIN
      PATCH_IF( fj_structure_type == 0x70 && num == fj_delete_mode && fj_deleted == 0x00 )BEGIN
        SET fj_deleted = 0x01
      END ELSE BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reassociating vertices to container %num%.~ END
        WRITE_LONG LONG_AT 0x70 + 0xc0 * ( num - fj_deleted ) + 0x50 fj_vertex_idx
        PHP_EACH ~are_container_%num%_vertex~ AS num1 => value1 BEGIN
          INSERT_BYTES fj_position 0x04
          WRITE_LONG   fj_position value1
          WRITE_SHORT  0x80        THIS + 0x01
          SET ++fj_vertex_idx
          SET fj_position += 0x04
        END
      END
    END
    SET fj_deleted = 0x00
    PATCH_IF fj_structure_type == 0x70 && fj_delete_mode == ` 0 BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Adding vertices to new container.~ END
      WRITE_LONG fj_return_offset + 0x50 fj_vertex_idx
      PHP_EACH fj_vertex AS num => off BEGIN
        SET ++fj_vertex_idx
        INSERT_BYTES fj_position 0x04
        WRITE_SHORT  0x80 THIS + 0x01
      END
      PHP_EACH fj_vertex AS num => off BEGIN
        WRITE_LONG fj_position off
        SET fj_position += 0x04
      END
    END
    PHP_EACH are_container AS num => structure BEGIN
      CLEAR_ARRAY EVAL ~are_container_%num%_vertex~
    END

    // vertices associated with doors
    PHP_EACH are_door      AS num => structure BEGIN
      PATCH_IF( fj_structure_type == 0xa8 && num == fj_delete_mode && fj_deleted == 0x00 )BEGIN
        SET fj_deleted = 0x01
      END ELSE BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reassociating vertices to door %num%.~ END
        WRITE_LONG LONG_AT 0xa8 + 0xc8 * ( num - fj_deleted ) + 0x2c fj_vertex_idx
        PHP_EACH ~are_door_open_%num%_vertex~ AS num1 => value1 BEGIN
          INSERT_BYTES fj_position 0x04
          WRITE_LONG   fj_position value1
          SET ++fj_vertex_idx
          SET fj_position += 0x04
          WRITE_SHORT  0x80 THIS + 0x01
        END
        WRITE_LONG LONG_AT 0xa8 + 0xc8 * ( num - fj_deleted ) + 0x34 fj_vertex_idx
        PHP_EACH ~are_door_closed_%num%_vertex~ AS num1 => value1 BEGIN
          INSERT_BYTES fj_position 0x04
          WRITE_LONG   fj_position value1
          SET ++fj_vertex_idx
          SET fj_position += 0x04
          WRITE_SHORT  0x80 THIS + 0x01
        END
        WRITE_LONG LONG_AT 0xa8 + 0xc8 * ( num - fj_deleted ) + 0x48 fj_vertex_idx
        PHP_EACH ~are_cell_open_%num%_vertex~ AS num1 => value1 BEGIN
          INSERT_BYTES fj_position 0x04
          WRITE_LONG   fj_position value1
          SET ++fj_vertex_idx
          SET fj_position += 0x04
          WRITE_SHORT  0x80 THIS + 0x01
        END
        WRITE_LONG LONG_AT 0xa8 + 0xc8 * ( num - fj_deleted ) + 0x50 fj_vertex_idx
        PHP_EACH ~are_cell_closed_%num%_vertex~ AS num1 => value1 BEGIN
          INSERT_BYTES fj_position 0x04
          WRITE_LONG   fj_position value1
          SET ++fj_vertex_idx
          SET fj_position += 0x04
          WRITE_SHORT  0x80 THIS + 0x01
        END
      END
    END
    SET fj_deleted = 0x00
    PATCH_FOR_EACH value1 IN
      door_open door_closed cell_open cell_closed
    BEGIN
      CLEAR_ARRAY EVAL ~are_%value1%_%num%_vertex~
    END
    PATCH_IF( fj_structure_type == 0xa8 && fj_delete_mode == ` 0 )BEGIN
      PATCH_IF fj_debug BEGIN PATCH_PRINT ~Adding vertices to new door.~ END
      WRITE_LONG fj_return_offset + 0x2c fj_vertex_idx
      WRITE_LONG fj_return_offset + 0x34
        LONG_AT (fj_return_offset + 0x2c) + SHORT_AT (fj_return_offset + 0x30)
      WRITE_LONG fj_return_offset + 0x48
        LONG_AT (fj_return_offset + 0x34) + SHORT_AT (fj_return_offset + 0x32)
      WRITE_LONG fj_return_offset + 0x50
        LONG_AT (fj_return_offset + 0x48) + SHORT_AT (fj_return_offset + 0x4c)
      PATCH_FOR_EACH vertex_type IN
        door_open door_closed cell_open cell_closed
      BEGIN
        PHP_EACH ~fj_%vertex_type%_vert~ AS num => off BEGIN
          INSERT_BYTES fj_position 0x04
          WRITE_SHORT  0x80 THIS + 0x01
        END
        PHP_EACH ~fj_%vertex_type%_vert~ AS num => off BEGIN
          WRITE_LONG fj_position off
          SET fj_position += 0x04
        END
        CLEAR_ARRAY EVAL ~fj_%vertex_type%_vert~
      END
    END

  END // adding vertices

  // reinsert embedded creatures
  PATCH_IF( key_0 == 0x54 )BEGIN
    PHP_EACH are_embedded_cre AS num => value1 BEGIN
      PATCH_IF( fj_structure_type == 0x54 && num == fj_delete_mode && fj_deleted == 0x00 )BEGIN
        SET fj_deleted = 0x01
      END ELSE BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reassociating embedded creature to actor %num%.~ END
        WRITE_LONG   LONG_AT 0x54 + ( num - fj_deleted ) * 0x110 + 0x88 fj_position
        INSERT_BYTES fj_position LONG_AT ( LONG_AT 0x54 + ( num - fj_deleted ) * 0x110 + 0x8c )
        WRITE_ASCIIE fj_position ~%value1%~
        SET fj_position += LONG_AT (LONG_AT 0x54 + ( num - fj_deleted ) * 0x110 + 0x8c)
      END
    END
    CLEAR_ARRAY are_embedded_cre
    SET fj_deleted = 0x00
    PATCH_IF( fj_structure_type == 0x54 && fj_delete_mode == ` 0 && !( fj_loading & 0x01 ) )BEGIN
      PATCH_IF( FILE_EXISTS ~%fj_cre_embedded%~ )BEGIN
        SET off = BUFFER_LENGTH // we do a stupid dance here to avoid INNER_ACTION
        APPEND_FILE_EVALUATE ~%fj_cre_embedded%~
        READ_ASCII   off fj_cre_embedded ( BUFFER_LENGTH - off )
        DELETE_BYTES off STRING_LENGTH EVAL ~%fj_cre_embedded%~
      END ELSE PATCH_IF( FILE_EXISTS_IN_GAME ~%fj_cre_resref%.cre~ ) BEGIN
        INNER_PATCH_FILE ~%fj_cre_resref%.cre~ BEGIN
          READ_ASCII 0x00 fj_cre_embedded ( BUFFER_LENGTH )
        END
      END
      PATCH_IF( ~%fj_cre_embedded%~ STR_CMP ~~ )BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Embedding creature to new actor.~ END
        WRITE_LONG   fj_return_offset + 0x88 fj_position
        WRITE_LONG   fj_return_offset + 0x8c STRING_LENGTH EVAL ~%fj_cre_embedded%~
        INSERT_BYTES fj_position             LONG_AT (fj_return_offset + 0x8c)
        WRITE_ASCIIE fj_position             ~%fj_cre_embedded%~
        SET fj_position += LONG_AT ( fj_return_offset + 0x8c )
      END ELSE BEGIN
        WRITE_LONG   fj_return_offset + 0x28 THIS | 0x01 // if we didn\'t find a .cre, mark it unembedded
      END
    END
  END ELSE

  // reinsert embedded projectile effects
  PATCH_IF( key_0 == 0xcc )BEGIN
    PHP_EACH are_embedded_eff AS num => value1 BEGIN
      PATCH_IF( fj_structure_type == 0xcc && fj_delete_mode == num && fj_deleted == 0x00 )BEGIN
        SET fj_deleted = 0x01
      END ELSE BEGIN
        PATCH_IF fj_debug BEGIN PATCH_PRINT ~Reassociating embedded effects to projectile %num%.~ END
        WRITE_LONG   LONG_AT 0xcc + ( num - fj_deleted ) * 0x1c + 0x08 fj_position
        INSERT_BYTES fj_position SHORT_AT (LONG_AT 0xcc + ( num - fj_deleted ) * 0x1c + 0x0c)
        WRITE_ASCIIE fj_position ~%value1%~
        SET fj_position += SHORT_AT (LONG_AT 0xcc + ( num - fj_deleted ) * 0x1c + 0x0c)
      END
    END
    SET fj_deleted = 0x00
    CLEAR_ARRAY are_embedded_eff
    PATCH_IF( fj_structure_type == 0xcc && fj_delete_mode == ` 0 )BEGIN
      WRITE_LONG fj_return_offset + 0x08 fj_position
      PHP_EACH fj_embedded_eff AS num => value1 BEGIN
        PATCH_IF( FILE_EXISTS ~%value1%~ )BEGIN
          SET off = BUFFER_LENGTH
          APPEND_FILE_EVALUATE ~%value1%~
          READ_ASCII   off + 0x08 value1 (0x108)
          DELETE_BYTES off 0x110
        END ELSE PATCH_IF( FILE_EXISTS_IN_GAME ~%value1%.eff~ )BEGIN
          INNER_PATCH_FILE ~%value1%.eff~ BEGIN
            READ_ASCII 0x08 value1 (0x108)
          END
        END ELSE BEGIN
          TEXT_SPRINT value1 ~~
        END
        PATCH_IF( ~%value1%~ STR_CMP ~~ )BEGIN
          PATCH_IF fj_debug BEGIN PATCH_PRINT ~Adding effect %num% to new embedded projectile.~ END
          WRITE_SHORT  fj_return_offset + 0x0c THIS + 0x108
          INSERT_BYTES fj_position 0x108
          WRITE_ASCIIE fj_position ~%value1%~
          SET fj_position += 0x108
        END
      END
    END
    CLEAR_ARRAY fj_embedded_eff
  END

END // php $struct: everything added

// restoring Icewind Dale II\'s special snowflakiness
PATCH_IF is_id2 BEGIN
  PATCH_FOR_EACH off IN
    0x54 0x5c 0x60 0x68 0x70 0x78 0x7c 0x84
    0x88 0xa0 0xa8 0xb0 0xb8 0xbc 0xc0
  BEGIN
    PATCH_IF LONG_AT off BEGIN
      WRITE_LONG off THIS + 0x10
    END
  END
  INSERT_BYTES 0x54 0x10
  WRITE_ASCIIE 0x54 ~%id2_header%~
  SET fj_return_offset += 0x10
  GET_OFFSET_ARRAY fj_id_actor ARE_V91_ACTORS
  PHP_EACH fj_id_actor AS key => value BEGIN
    PATCH_IF(
      LONG_AT( value + 0x88 ) > 0x00 &&
      LONG_AT( value + 0x28 ) & 0x01 == 0x00
    )BEGIN
      WRITE_LONG value + 0x88 THIS + 0x10
    END
  END
END

END

// EOF
  ");
(".../WEIDU_NAMESPACE/fj_cre_validity.tpa","DEFINE_PATCH_FUNCTION ~FL#FJ_CRE_VALIDITY~
  INT_VAR
    do_message = 0
    do_reindex = 1
    do_eff = 1
  RET
    valid
BEGIN
  LPF ~FJ_CRE_VALIDITY~ RET valid END
END

DEFINE_PATCH_FUNCTION ~FL#FJ_CRE_REINDEX~
  INT_VAR
    do_reindex = 1
    do_eff = 1
BEGIN
  LPF ~FJ_CRE_REINDEX~ END
END

DEFINE_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid BEGIN
  SET do_message = IS_AN_INT do_message ? do_message : 0
  SPRINT m1 ~is corrupt~
  SPRINT m2 ~below minimum length~
  SPRINT m3 ~header misplaced~
  SPRINT m4 ~extended structures point to header~
  SPRINT sg ~CRE V1.0~
  valid = 1
  PATCH_IF NOT ENGINE_IS pstee AND ~%SOURCE_RES%~ STRING_EQUAL_CASE charbase BEGIN
    valid = 0
  END ELSE BEGIN
    PATCH_IF BUFFER_LENGTH < 0x2d4 BEGIN
      valid = 0
      PATCH_IF do_message THEN BEGIN
        PATCH_PRINT ~%SOURCE_FILE% %m1%: %m2%.~ //is corrupt: below minimum length
      END
    END ELSE BEGIN
      READ_ASCII 0 sg
      PATCH_IF ~%sg%~ STR_CMP ~CRE V1.0~ BEGIN
        valid = 0
        PATCH_IF do_message THEN BEGIN
          PATCH_PRINT ~%SOURCE_FILE% %m1%: %m3%.~ //is corrupt: header misplaced
        END
      END ELSE BEGIN
        DEFINE_ASSOCIATIVE_ARRAY cre_offset BEGIN
          0x2a0 => 0x2a4
          0x2a8 => 0x2ac
          0x2b0 => 0x2b4
          0x2b8 => 0x2c0
          0x2bc => 0x2c0
          0x2c4 => 0x2c8
        END
        PHP_EACH cre_offset AS tmp => tmp_1 BEGIN
          READ_LONG tmp_0 tmp_2
          READ_LONG tmp_1 tmp_3
          PATCH_IF tmp_3 = 0 && tmp_2 < 0x2d4 BEGIN
            WRITE_LONG tmp_0 0x2d4
          END
          PATCH_IF tmp_3 != 0 && tmp_2 < 0x2d4 BEGIN
            valid = 0
            PATCH_IF do_message THEN BEGIN
              PATCH_PRINT ~%SOURCE_FILE% %m1%: %m4%.~ //is corrupt: extended structures point to header
            END
          END
        END
      END
    END
  END

  PATCH_IF valid THEN BEGIN
    LAUNCH_PATCH_FUNCTION ~FJ_CRE_REINDEX~ END
  END
END

DEFINE_PATCH_FUNCTION ~FJ_CRE_REINDEX~ BEGIN
  SET do_eff = IS_AN_INT do_eff ? do_eff : 1
  SET do_reindex = IS_AN_INT do_reindex ? do_reindex : 1
  fv = 0
  kso = 0x2d4
  ksc = 0
  smo = 0x2d4
  smc = 0
  mso = 0x2d4
  msc = 0
  iso = 0x2d4
  ilo = 0x2d4
  ilc = 0
  elo = 0x2d4
  elc = 0
  i_0 = 0
  off_0 = 0
  off_1 = 0
  tmp_0 = 0
  tmp_1 = 0
  SPRINT ks fail
  SPRINT sm fail
  SPRINT ms fail
  SPRINT is fail
  SPRINT il fail
  SPRINT el fail
  READ_BYTE 0x33 fv //EFF version
  PATCH_IF (fv = 0) AND (ENGINE_IS ~soa tob pstee~ OR
                         FILE_EXISTS_IN_GAME monkfist.2da) && do_eff
  BEGIN
    LAUNCH_PATCH_FUNCTION ~FJ_CRE_EFF_V2~ END
  END
  PATCH_IF (fv != 0) AND NOT ENGINE_IS ~soa tob pstee~ AND
           NOT FILE_EXISTS_IN_GAME monkfist.2da && do_eff
  BEGIN
    LAUNCH_PATCH_FUNCTION ~T-CRE_EFF_V1~ END
  END
  PATCH_IF do_reindex BEGIN
    READ_BYTE 0x33 fv //EFF version
    PATCH_IF GAME_IS ~tutu tutu_totsc~ BEGIN //Fix buggered Tutu refs
      FOR (s1 = 0xa4; s1 < 0x234; s1 += 0x4) BEGIN
        READ_LONG s1 ss //Soundslots
        PATCH_IF ss > 10000000 BEGIN
          WRITE_LONG s1 ~-1~
        END
      END
    END
    READ_LONG 0x2a0 kso //Known spells offset
    READ_LONG 0x2a4 ksc //Known spells count
    READ_LONG 0x2a8 smo //Spell memorization info offset
    READ_LONG 0x2ac smc //Spell memorization info count
    READ_LONG 0x2b0 mso //Memorized spells offset
    READ_LONG 0x2b4 msc //Memorized spells count
    READ_LONG 0x2b8 iso //Item slot offset
    READ_LONG 0x2bc ilo //Item offset
    READ_LONG 0x2c0 ilc //Item count
    READ_LONG 0x2c4 elo //Effects offset
    READ_LONG 0x2c8 elc //Effects count
    READ_ASCII kso ks ELSE fail (0xc * ksc)
    READ_ASCII smo sm ELSE fail (0x10 * smc)
    READ_ASCII mso ms ELSE fail (0xc * msc)
    READ_ASCII iso is ELSE fail (0x50)
    READ_ASCII ilo il ELSE fail (0x14 * ilc)
    READ_ASCII elo el ELSE fail (elc * (0x30 + ((fv & 0x1) = 0x1 ? 0xd8 : 0)))
    DELETE_BYTES 0x2d4 BUFFER_LENGTH - 0x2d4
    off_0 = 0x2d4
    WRITE_LONG 0x2a0 off_0
    PATCH_IF ~%ks%~ STR_CMP fail BEGIN
      INSERT_BYTES off_0 0xc * ksc
      WRITE_ASCIIE off_0 ~%ks%~
    END ELSE BEGIN
      ksc = 0
      WRITE_LONG 0x2a4 ksc
    END
    off_0 += 0xc * ksc
    WRITE_LONG 0x2a8 off_0
    INSERT_BYTES off_0 0x10 * 0x11
    PATCH_IF ~%sm%~ STR_CMP fail && smc = 0x11 BEGIN
      WRITE_ASCIIE off_0 ~%sm%~
    END ELSE BEGIN
      FOR (i_0 = 0; i_0 < 7; i_0 += 1) BEGIN
        WRITE_SHORT off_0 + i_0 * 0x10 i_0
      END
      FOR (i_0 = 0; i_0 < 9; i_0 += 1) BEGIN
        WRITE_SHORT off_0 + i_0 * 0x10 + 0x70 i_0
        WRITE_SHORT off_0 + i_0 * 0x10 + 0x76 1
      END
      WRITE_SHORT off_0 + 0x106 0x2
      PATCH_IF ~%sm%~ STR_CMP fail BEGIN
        PATCH_IF smc > 0x11 BEGIN
          msc = 0
          SPRINT ms fail
        END ELSE PATCH_IF smc < 0x11 && smc > 0 BEGIN
          PATCH_IF STRING_LENGTH EVALUATE_BUFFER ~%sm%~ = 0x10 * smc BEGIN
            smc = 0x11
            WHILE STRING_LENGTH EVALUATE_BUFFER ~%sm%~ > 0 BEGIN
              off_1 = 0
              INNER_PATCH_SAVE sm ~%sm%~ BEGIN
                READ_SHORT 0 tmp_0
                off_1 += tmp_0 * 0x10
                READ_SHORT 6 tmp_0
                off_1 += 0x70 * tmp_0 + (tmp_0 = 0x2 ? 0x10 : 0)
                READ_SHORT 8 tmp_0
                READ_ASCII 0 tmp_1 (0x10)
                DELETE_BYTES 0 0x10
              END
              WRITE_ASCIIE off_0 + off_1 ~%tmp_1%~
              FOR (off_1 += 0x10; off_1 < 0x110; off_1 += 0x10) BEGIN
                WRITE_SHORT off_0 + off_1 + 0x8 tmp_0
              END
            END
          END ELSE BEGIN
            smc = 0x11
            msc = 0
            SPRINT ms fail
          END
        END
      END
    END
    off_0 += 0x110
    WRITE_LONG 0x2b0 off_0
    PATCH_IF ~%ms%~ STR_CMP fail && ~%sm%~ STR_CMP fail && smc = 0x11 BEGIN
      INSERT_BYTES off_0 0xc * msc
      WRITE_ASCIIE off_0 ~%ms%~
    END ELSE BEGIN
      msc = 0
      WRITE_LONG 0x2b4 msc
    END
    smc = 0x11
    WRITE_LONG 0x2ac smc
    off_0 += 0xc * msc
    WRITE_LONG 0x2c4 off_0
    PATCH_IF ~%el%~ STR_CMP fail BEGIN
      INSERT_BYTES off_0 (elc * (0x30 + (((fv & 0x1) = 0x1) ? 0xd8 : 0)))
      WRITE_ASCIIE off_0 ~%el%~
    END ELSE BEGIN
      elc = 0
      WRITE_LONG 0x2c8 elc
    END
    off_0 += (elc * (0x30 + (((fv & 0x1) = 0x1) ? 0xd8 : 0)))
    WRITE_LONG 0x2bc off_0
    PATCH_IF ~%il%~ STR_CMP fail BEGIN
      INSERT_BYTES off_0 (0x14 * ilc)
      WRITE_ASCIIE off_0 ~%il%~
    END ELSE BEGIN
      ilc = 0
      WRITE_LONG 0x2c0 ilc
    END
    off_0 += 0x14 * ilc
    WRITE_LONG 0x2b8 off_0
    INSERT_BYTES off_0 0x50
    PATCH_IF ~%is%~ STR_CMP fail BEGIN
      WRITE_ASCIIE off_0 ~%is%~
    END ELSE BEGIN
      FOR (i_0 = 0; i_0 < 0x4c; i_0 += 2) BEGIN
        WRITE_SHORT off_0 + i_0 0xffff
      END
    END
    SOURCE_SIZE = off_0 + 0x50
  END
END

DEFINE_PATCH_FUNCTION ~FJ_CRE_EFF_V2~ BEGIN
  PATCH_IF BYTE_AT 0x33 != 1 BEGIN
    WRITE_BYTE 0x33 1
    READ_LONG 0x2c8 fc //Effects count
    PATCH_IF (fc > 0x0) BEGIN
      READ_LONG 0x2c4 fs //Effects offset
      READ_ASCII fs fx (0x30 * fc)
      PATCH_FOR_EACH f1 IN 0x2a0 0x2a8 0x2b0 0x2b8 0x2bc BEGIN
        READ_LONG f1 f2
        WRITE_LONG f1 ((f2 > fs) ? (f2 + (fc * (0x108 - 0x30))) : (f2 < 0x2d4 ? 0x2d4 : f2))
      END
      DELETE_BYTES fs (0x30 * fc)
      INSERT_BYTES fs (0x108 * fc)
      SPRINT rfx ~~
      INNER_PATCH ~%fx%~ BEGIN
        FOR (i1 = 0; i1 < fc; i1 += 1) BEGIN
          SOURCE_SIZE += 0xd8
          READ_SHORT ((i1 * 0x30) + 0x00) pc //Opcode
          READ_BYTE  ((i1 * 0x30) + 0x02) tg //Target
          READ_BYTE  ((i1 * 0x30) + 0x03) pw //Power
          READ_LONG  ((i1 * 0x30) + 0x04) p1 //Parameter 1
          READ_LONG  ((i1 * 0x30) + 0x08) p2 //Parameter 2
          READ_BYTE  ((i1 * 0x30) + 0x0c) tm //Timing mode
          READ_BYTE  ((i1 * 0x30) + 0x0d) dp //Dispellability
          READ_LONG  ((i1 * 0x30) + 0x0e) dr //Duration
          READ_BYTE  ((i1 * 0x30) + 0x12) b1 //Probability 1
          READ_BYTE  ((i1 * 0x30) + 0x13) b2 //Probability 2
          READ_ASCII ((i1 * 0x30) + 0x14) rf //ResRef
          READ_LONG  ((i1 * 0x30) + 0x1c) dt //Dice thrown
          READ_LONG  ((i1 * 0x30) + 0x20) dz //Die size
          READ_LONG  ((i1 * 0x30) + 0x24) st //Save type
          READ_LONG  ((i1 * 0x30) + 0x28) sb //Save bonus
          INNER_PATCH_SAVE ~rfx~ ~%rfx%~ BEGIN
            INSERT_BYTES ((i1 * 0x108) + 0x00) 0x110
            WRITE_LONG   ((i1 * 0x108) + 0x10) pc
            WRITE_LONG   ((i1 * 0x108) + 0x14) tg
            WRITE_LONG   ((i1 * 0x108) + 0x18) pw
            WRITE_LONG   ((i1 * 0x108) + 0x1c) p1
            WRITE_LONG   ((i1 * 0x108) + 0x20) p2
            WRITE_BYTE   ((i1 * 0x108) + 0x24) tm
            WRITE_LONG   ((i1 * 0x108) + 0x28) dr
            WRITE_SHORT  ((i1 * 0x108) + 0x2c) b1
            WRITE_SHORT  ((i1 * 0x108) + 0x2e) b2
            WRITE_ASCIIE ((i1 * 0x108) + 0x30) ~%rf%~
            WRITE_LONG   ((i1 * 0x108) + 0x38) dt
            WRITE_LONG   ((i1 * 0x108) + 0x3c) dz
            WRITE_LONG   ((i1 * 0x108) + 0x40) st
            WRITE_LONG   ((i1 * 0x108) + 0x44) sb
            WRITE_BYTE   ((i1 * 0x108) + 0x5c) dp
            WRITE_LONG   ((i1 * 0x108) + 0x80) (`0)
            WRITE_LONG   ((i1 * 0x108) + 0x84) (`0)
            WRITE_LONG   ((i1 * 0x108) + 0x88) (`0)
            WRITE_LONG   ((i1 * 0x108) + 0x8c) (`0)
            WRITE_LONG   ((i1 * 0x108) + 0xa4) (`0)
            DELETE_BYTES ((i1 * 0x108) + 0x08) 8
          END
        END
      END
      WRITE_ASCIIE fs ~%rfx%~
    END
  END
END

DEFINE_PATCH_FUNCTION ~T-CRE_EFF_V1~ BEGIN
  PATCH_IF BYTE_AT 0x33 != 0 BEGIN
    WRITE_BYTE 0x33 0
    READ_LONG 0x2c8 fc //Effects count
    PATCH_IF fc > 0 BEGIN
      nfc = fc
      READ_LONG 0x2c4 fs //Effects offset
      READ_ASCII fs fx (0x108 * fc)
      DELETE_BYTES fs (0x108 * fc)
      sz = 0 //Size to reduce
      SPRINT rfx ~~
      INNER_PATCH ~%fx%~ BEGIN
        FOR (t_1 = 0; t_1 < fc; t_1 += 1) BEGIN
          READ_LONG  (t_1 * 0x108 + 0x08) pc //Opcode
          READ_LONG  (t_1 * 0x108 + 0x0c) tg //Target
          READ_LONG  (t_1 * 0x108 + 0x10) pw //Power
          READ_LONG  (t_1 * 0x108 + 0x14) p1 //Parameter 1
          READ_LONG  (t_1 * 0x108 + 0x18) p2 //Parameter 2
          READ_SHORT (t_1 * 0x108 + 0x1c) tm //Timing mode
          READ_LONG  (t_1 * 0x108 + 0x20) dr //Duration
          READ_SHORT (t_1 * 0x108 + 0x24) b1 //Probability 1
          READ_SHORT (t_1 * 0x108 + 0x26) b2 //Probability 2
          READ_ASCII (t_1 * 0x108 + 0x28) rf //ResRef
          READ_LONG  (t_1 * 0x108 + 0x30) dt //Dice thrown
          READ_LONG  (t_1 * 0x108 + 0x34) dz //Die size
          READ_LONG  (t_1 * 0x108 + 0x38) st //Save type
          READ_LONG  (t_1 * 0x108 + 0x3c) sb //Save bonus
          READ_LONG  (t_1 * 0x108 + 0x54) dp //Dispellability
          INNER_PATCH_SAVE rfx ~%rfx%~ BEGIN
            tln = STRING_LENGTH ~%rfx%~
            PATCH_IF pc < 191 BEGIN //If a valid BG1 opcode
              sz += 0xd8
              INSERT_BYTES (tln + 0x00) 0x30
              WRITE_SHORT  (tln + 0x00) pc
              WRITE_BYTE   (tln + 0x02) tg
              WRITE_BYTE   (tln + 0x03) pw
              WRITE_LONG   (tln + 0x04) p1
              WRITE_LONG   (tln + 0x08) p2
              WRITE_BYTE   (tln + 0x0c) tm
              WRITE_BYTE   (tln + 0x0d) dp
              WRITE_LONG   (tln + 0x0e) dr
              WRITE_BYTE   (tln + 0x12) b1
              WRITE_BYTE   (tln + 0x13) b2
              WRITE_ASCIIE (tln + 0x14) ~%rf%~
              WRITE_LONG   (tln + 0x1c) dt
              WRITE_LONG   (tln + 0x20) dz
              WRITE_LONG   (tln + 0x24) st
              WRITE_LONG   (tln + 0x28) sb
            END ELSE BEGIN
              sz += 0x108
              nfc = nfc - 1
            END
          END
        END
      END
      PATCH_FOR_EACH f1 IN 0x2a0 0x2a8 0x2b0 0x2b8 0x2bc BEGIN
        READ_LONG f1 f2
        WRITE_LONG f1 ((f2 > fs) ? (f2 - sz) : (f2 < 0x2d4 ? 0x2d4 : f2))
      END
      PATCH_IF nfc > 0 BEGIN
        INSERT_BYTES fs (0x30 * nfc)
      WRITE_ASCIIE fs ~%rfx%~
      END
      WRITE_LONG 0x2c8 nfc //Update effects count
      SOURCE_SIZE -= sz
    END
  END
END
  ");
(".../WEIDU_NAMESPACE/fl_functions.tpa","<<<<<<<< .../fl#inlined/null.file
>>>>>>>>

DEFINE_PATCH_FUNCTION ADD_CRE_SCRIPT
  INT_VAR
    offset_start = SCRIPT_OVERRIDE
    offset_end = SCRIPT_DEFAULT
  STR_VAR
    script = \"\"
  RET
    success
BEGIN
  PATCH_IF \"%script%\" STR_CMP \"\" BEGIN
    READ_ASCII 0 sig (3)
    PATCH_IF \"%sig%\" STR_CMP \"CRE\" BEGIN
      PATCH_FAIL \"ERROR: ADD_CRE_SCRIPT called on invalid creature file\"
    END
    PATCH_FOR_EACH var IN offset_start offset_end BEGIN
      PATCH_IF EVAL \"%%var%%\" < 0 BEGIN
        PATCH_FAIL \"ERROR: ADD_CRE_SCRIPT: invalid argument: %var%\"
      END
    END
    PATCH_IF offset_end < offset_start BEGIN
      PATCH_FAIL \"ERROR: ADD_CRE_SCRIPT: offset_end cannot be less than offset_start\"
    END
    PATCH_IF offset_end > BUFFER_LENGTH BEGIN
      PATCH_FAIL \"ERROR: ADD_CRE_SCRIPT: offset_end cannot be greater than the size of the file\"
    END
    script_length = 0x8
    done = 0
    success = 0
    FOR (script_offset = offset_start; script_offset <= offset_end && !done; script_offset += script_length) BEGIN
      READ_ASCII script_offset escript
      PATCH_IF \"%escript%\" STRING_EQUAL \"\" OR \"%escript%\" STRING_EQUAL_CASE \"none\" BEGIN
        WRITE_ASCIIE script_offset \"%script%\"
        done = 1
        success = 1
      END
    END
    PATCH_IF !done BEGIN
      PATCH_PRINT \"WARNING: ADD_CRE_SCRIPT was unable to assign script %script%\"
    END
  END
END


DEFINE_ACTION_FUNCTION SUBSTRING
  INT_VAR
    start = 0
    length = 0
  STR_VAR
    string = \"\"
  RET
    substring
BEGIN
  ACTION_FOR_EACH var IN start length BEGIN
    ACTION_IF EVAL \"%%var%%\" < 0 BEGIN
      FAIL \"ERROR: SUBSTRING: invalid argument: %var%\"
    END
  END
  ACTION_IF length > STRING_LENGTH \"%string%\" BEGIN
    FAIL \"ERROR: SUBSTRING: the substring cannot be longer than the string\"
  END
  ACTION_IF start > STRING_LENGTH \"%string%\" BEGIN
    FAIL \"ERROR: SUBSTRING: the substring cannot be taken at an offset greater than the string length\"
  END
  ACTION_IF start + length > STRING_LENGTH \"%string%\" BEGIN
    FAIL \"ERROR: SUBSTRING: attempt to take substring out of bounds\"
  END
  OUTER_PATCH \"%string%\" BEGIN
    READ_ASCII start substring (length)
  END
END

DEFINE_PATCH_FUNCTION SUBSTRING
  INT_VAR
    start = 0
    length = 0
  STR_VAR
    string = \"\"
  RET
    substring
BEGIN
  INNER_ACTION BEGIN
    LAF SUBSTRING INT_VAR start length STR_VAR string RET substring END
  END
END
  ");
(".../WEIDU_NAMESPACE/get_unique_file_name.tpa","DEFINE_ACTION_FUNCTION ~GET_UNIQUE_FILE_NAME~
  STR_VAR extension = \"\"
          base = \"\"
  RET filename
  BEGIN
    OUTER_PATCH ~~ BEGIN
      LPF ~GET_UNIQUE_FILE_NAME~ STR_VAR extension = EVALUATE_BUFFER \"%extension%\" base = EVALUATE_BUFFER \"%base%\" RET filename = filename END
    END
END

DEFINE_PATCH_FUNCTION ~BASE36~
  INT_VAR
    value = 0
  RET
    base36
  BEGIN
    PATCH_IF value < 0 || value >= 36 * 36 * 36 * 36 THEN BEGIN
      PATCH_FAIL ~BASE36 called on %value% (out of bounds 0 <= x < 36 **4)~
    END

    INNER_PATCH_SAVE base36 ~0000~ BEGIN
      FOR (i = 3; i >= 0; --i) BEGIN
        digit = value - (value / 36) * 36
        value = value / 36
        WRITE_BYTE i digit + (digit < 10 ? 0x30 : 0x57)
      END
    END
END

DEFINE_PATCH_FUNCTION ~GET_UNIQUE_FILE_NAME~
  STR_VAR
          extension = \"\"
          base = \"\"
  RET filename
  BEGIN
    PATCH_IF ~%extension%~ STRING_EQUAL_CASE ~~ THEN BEGIN
      PATCH_FAIL ~GET_UNIQUE_FILE_NAME requires to define the extension variable.~
    END

    INNER_ACTION BEGIN
      ACTION_IF ! FILE_EXISTS_IN_GAME ~get_unique_filename_%extension%.ids~ THEN BEGIN
        <<<<<<<< empty
        >>>>>>>>
        COPY + empty ~override/get_unique_filename_%extension%.ids~
      END
    END

    value = ~%base%~ STR_CMP ~~ ?
      IDS_OF_SYMBOL (~get_unique_filename_%extension%~ ~%base%~) : 0 - 1
    PATCH_IF value = 0 - 1 THEN BEGIN
      found = 0
      WHILE !found BEGIN
        ++value
        LPF ~BASE36~ INT_VAR value = value RET maybe = base36 END
        LOOKUP_IDS_SYMBOL_OF_INT exists ~get_unique_filename_%extension%~ value
        PATCH_IF IS_AN_INT exists
          && !FILE_EXISTS_IN_GAME ~__%maybe%.%extension%~ THEN BEGIN
          found = 1
        END
      END
      INNER_ACTION BEGIN
        APPEND + ~get_unique_filename_%extension%.ids~ ~%value% %base%~
      END
    END ELSE BEGIN
      LPF ~BASE36~ INT_VAR value = value RET maybe = base36 END
    END

    SPRINT filename ~__%maybe%~
END
  ");
(".../WEIDU_NAMESPACE/g_functions.tpa","DEFINE_PATCH_FUNCTION ~DELETE_SPELL_EFFECT~
  INT_VAR opcode_to_delete = 0
BEGIN
  LAUNCH_PATCH_MACRO ~DELETE_SPELL_EFFECT~
END

DEFINE_PATCH_FUNCTION ~DELETE_ITEM_EFFECT~
  INT_VAR opcode_to_delete = 0
BEGIN
  LAUNCH_PATCH_MACRO ~DELETE_ITEM_EFFECT~
END

DEFINE_PATCH_FUNCTION ~DELETE_ITEM_EQEFFECT~
  INT_VAR opcode_to_delete = 0
BEGIN
  LAUNCH_PATCH_MACRO ~DELETE_ITEM_EQEFFECT~
END

DEFINE_PATCH_FUNCTION ~DELETE_CRE_EFFECT~
  INT_VAR opcode_to_delete = 0
BEGIN
  LAUNCH_PATCH_MACRO ~DELETE_CRE_EFFECT~
END

DEFINE_PATCH_FUNCTION ~ITEM_EFFECT_TO_SPELL~
  INT_VAR type = 3
          header = 99
          insert_point = \"-1\"
  STR_VAR new_itm_spl = 0
BEGIN
  LAUNCH_PATCH_MACRO ~ITEM_EFFECT_TO_SPELL~
END

DEFINE_PATCH_FUNCTION ~ADD_SPELL_EFFECT~
  INT_VAR opcode = 0
          target = 0
          timing = 0
          parameter1 = 0
          parameter2 = 0
          power = 0
          resist_dispel = 0
          duration = 0
          probability1 = 100
          probability2 = 0
          dicenumber = 0
          dicesize = 0
          savingthrow = 0
          savebonus = 0
          header = 0
          insert_point = \"-1\"
          special = 0
          ___#special = special
  STR_VAR resource = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_SPELL_EFFECT~
END

DEFINE_PATCH_FUNCTION ~ADD_ITEM_EFFECT~
  INT_VAR opcode = 0
          target = 0
          timing = 0
          parameter1 = 0
          parameter2 = 0
          power = 0
          resist_dispel = 0
          duration = 0
          probability1 = 100
          probability2 = 0
          dicenumber = 0
          dicesize = 0
          savingthrow = 0
          savebonus = 0
          header = 0
		  type = 3
		  insert_point = \"-1\"
          special = 0
          ___#special = special
  STR_VAR resource = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_ITEM_EFFECT~
END

DEFINE_PATCH_FUNCTION ~ADD_ITEM_EQEFFECT~
  INT_VAR
    opcode = 0
    target = 0
    timing = 0
    parameter1 = 0
    parameter2 = 0
    power = 0
    resist_dispel = 0
    duration = 0
    probability1 = 100
    probability2 = 0
    dicenumber = 0
    dicesize = 0
    savingthrow = 0
    savebonus = 0
    special = 0
    insert_point = 0
    ___#special = special
  STR_VAR
    resource = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_ITEM_EQEFFECT~
END

DEFINE_PATCH_FUNCTION ~ADD_SPELL_CFEFFECT~
  INT_VAR
    opcode = 0
    target = 0
    timing = 0
    parameter1 = 0
    parameter2 = 0
    power = 0
    resist_dispel = 0
    duration = 0
    probability1 = 100
    probability2 = 0
    dicenumber = 0
    dicesize = 0
    savingthrow = 0
    savebonus = 0
    special = 0
    insert_point = 0
    ___#special = special
  STR_VAR
    resource = ~~
BEGIN
  LPM ~ADD_SPELL_CFEFFECT~
END

DEFINE_PATCH_FUNCTION ~ADD_CRE_EFFECT~
  INT_VAR opcode = 0
          target = 0
          timing = 0
          parameter1 = 0
          parameter2 = 0
          power = 0
          resist_dispel = 0
          duration = 0
          probability1 = 100
          probability2 = 0
          dicenumber = 0
          dicesize = 0
          savingthrow = 0
          savebonus = 0
          header = 0
          parameter3 = 0
          parameter4 = 0
          school = 0
          special = 0
          ___#special = special
          lowestafflvl = 0
          highestafflvl = 0
          casterx = 0 - 1
          castery = 0 - 1
          targetx = 0 - 1
          targety = 0 - 1
          restype = 0
          sourceslot = \"-1\"
          casterlvl = 0
          sectype = 0
          insert_point = 0
  STR_VAR resource = ~~
          resource2 = ~~
          vvcresource = ~~
          effsource = ~~
          effvar = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_CRE_EFFECT~
END

DEFINE_PATCH_FUNCTION ~DELETE_CRE_ITEM~
  STR_VAR item_to_delete = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~DELETE_CRE_ITEM~
END

DEFINE_PATCH_FUNCTION ~DELETE_STORE_ITEM~
  STR_VAR item_to_delete = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~DELETE_STORE_ITEM~
END

DEFINE_PATCH_FUNCTION ~DELETE_AREA_ITEM~
  STR_VAR item_to_delete = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~DELETE_AREA_ITEM~
END

DEFINE_PATCH_FUNCTION ~REPLACE_STORE_ITEM~
  INT_VAR number_in_stock = 0
          charges1 = 0
          charges2 = 0
          charges3 = 0
  STR_VAR flags = ~~
          old_item = ~~
          new_item = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~REPLACE_STORE_ITEM~
END

DEFINE_PATCH_FUNCTION ~REPLACE_AREA_ITEM~
  INT_VAR charges1 = 0
          charges2 = 0
          charges3 = 0
  STR_VAR flags = ~~
          old_item = ~~
          new_item = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~REPLACE_AREA_ITEM~
END


DEFINE_PATCH_FUNCTION ~ADD_AREA_ITEM~
  INT_VAR container_to_add_to = 1
          charges1 = 0
          charges2 = 0
          charges3 = 0
  STR_VAR flags = ~~
          item_to_add = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_AREA_ITEM~
END

DEFINE_PATCH_FUNCTION ~ADD_CRE_ITEM_FLAGS~
  STR_VAR item_to_change = ~~
          flags = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_CRE_ITEM_FLAGS~
END

DEFINE_PATCH_FUNCTION ~REMOVE_CRE_ITEM_FLAGS~
  STR_VAR item_to_change = ~~
          flags = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~REMOVE_CRE_ITEM_FLAGS~
END

DEFINE_PATCH_FUNCTION ~SET_CRE_ITEM_FLAGS~
  STR_VAR item_to_change = ~~
          flags = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~SET_CRE_ITEM_FLAGS~
END

DEFINE_PATCH_FUNCTION ~ADD_AREA_REGION_TRIGGER~
  INT_VAR AREA_RT_TYPE = 0
          AREA_RT_BBOX_LOW_X = 0
          AREA_RT_BBOX_LOW_Y = 0
          AREA_RT_BBOX_HIGH_X = 0
          AREA_RT_BBOX_HIGH_Y = 0
          AREA_RT_VERTEX_PAIRS = 0
          AREA_RT_FLAGS = 0
          AREA_RT_TRAP_DET_DIFF = 0
          AREA_RT_TRAP_REM_DIFF = 0
          AREA_RT_TRAP_IS_SET = 0
          AREA_RT_TRAP_DETECTED = 0
          AREA_RT_LAUNCH_POINT_X = 0
          AREA_RT_LAUNCH_POINT_Y = 0
          AREA_RT_ALT_USE_POINT_X = 0
          AREA_RT_ALT_USE_POINT_Y = 0
          AREA_RT_CURSOR_INDEX = 0
  STR_VAR AREA_RT_NAME = ~~
          AREA_RT_KEY_ITEM = ~~
          AREA_RT_REGION_SCRIPT = ~~
          AREA_RT_DEST_AREA = ~~
          AREA_RT_ENTRANCE_NAME = ~~
          AREA_RT_INFO_TEXT = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_AREA_REGION_TRIGGER~
END

DEFINE_PATCH_FUNCTION ~ADD_AREA_REGION~
  INT_VAR AREA_RT_TYPE = 0
          AREA_RT_BBOX_LOW_X = 0
          AREA_RT_BBOX_LOW_Y = 0
          AREA_RT_BBOX_HIGH_X = 0
          AREA_RT_BBOX_HIGH_Y = 0
          AREA_RT_VERTEX_PAIRS = 0
          AREA_RT_FLAGS = 0
          AREA_RT_TRAP_DET_DIFF = 0
          AREA_RT_TRAP_REM_DIFF = 0
          AREA_RT_TRAP_IS_SET = 0
          AREA_RT_TRAP_DETECTED = 0
          AREA_RT_LAUNCH_POINT_X = 0
          AREA_RT_LAUNCH_POINT_Y = 0
          AREA_RT_ALT_USE_POINT_X = 0
          AREA_RT_ALT_USE_POINT_Y = 0
          AREA_RT_CURSOR_INDEX = 0
  STR_VAR AREA_RT_NAME = ~~
          AREA_RT_KEY_ITEM = ~~
          AREA_RT_REGION_SCRIPT = ~~
          AREA_RT_DEST_AREA = ~~
          AREA_RT_ENTRANCE_NAME = ~~
          AREA_RT_INFO_TEXT = ~~
BEGIN
  LAUNCH_PATCH_MACRO ~ADD_AREA_REGION~
END
  ");
(".../WEIDU_NAMESPACE/g_macros.tpa","OUTER_PATCH ___#qwerty BEGIN
  WRITE_BYTE 0 0
  READ_ASCII 0 ___#nil (1)
END


//copies all effects from an item and store them in spell. new_itm_spl required (which should already lie in override folder. .spl is NOT implied)
DEFINE_PATCH_MACRO ~ITEM_EFFECT_TO_SPELL~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x71) BEGIN
    READ_LONG   0x64 ___#abil_off
    READ_SHORT  0x68 ___#abil_num
    READ_LONG   0x6a ___#fx_off
    SET ___#index1 = ___#abil_num
    WHILE (___#index1 > 0) BEGIN
      SET ___#index1 = (___#index1 - 1)
      READ_BYTE   (___#abil_off +        (___#index1 * 0x38)) ___#type
      READ_SHORT  (___#abil_off + 0x1e + (___#index1 * 0x38)) ___#abil_fx_num
      READ_SHORT  (___#abil_off + 0x20 + (___#index1 * 0x38)) ___#abil_1fx_index

      ___#have_type = VARIABLE_IS_SET type && IS_AN_INT type
      ___#type_match = (!___#have_type && ___#type = 3) || (___#have_type && (___#type = type || type = 99))
      ___#have_header = VARIABLE_IS_SET header && IS_AN_INT header
      ___#header_match = !___#have_header || (___#have_header && (___#index1 = header || header = 99))

      PATCH_IF ((!___#have_type && ___#have_header) || ___#type_match) AND ((___#have_type && !___#have_header) || ___#header_match) BEGIN //ability is correct or unspecified and header matches

        READ_ASCII (___#fx_off + ___#abil_1fx_index * 0x30) ___#effects (0x30 * ___#abil_fx_num)

        INNER_ACTION BEGIN
          COPY_EXISTING ~%new_itm_spl%~ ~override/%new_itm_spl%~
            READ_LONG   0x64 ___#abil_off2
            READ_SHORT  0x68 ___#abil_num2
            READ_LONG   0x6a ___#fx_off2
            READ_SHORT  (___#abil_off2 + 0x1e + (0 * 0x28)) ___#abil_fx_num2
            ___#insert_point = !IS_AN_INT insert_point OR insert_point < 0 OR
              insert_point > ___#abil_fx_num2 ? ___#abil_fx_num2 : insert_point
            INSERT_BYTES (___#fx_off2 + ___#insert_point * 0x30) (0x30 * ___#abil_fx_num)
            WRITE_EVALUATED_ASCII (___#fx_off2 + ___#insert_point * 0x30) ~%___#effects%~ //copy effect
            WRITE_SHORT  (___#abil_off2 + 0x1e + (0 * 0x28)) (___#abil_fx_num2 + ___#abil_fx_num)
          //no offsets to correct
        END

      END
    END
  END
END


//need parameters: opcode_to_delete
DEFINE_PATCH_MACRO ~DELETE_SPELL_EFFECT~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x71) THEN BEGIN
    READ_LONG  0x64 ___#abil_off
    READ_SHORT 0x68 ___#abil_num
    READ_LONG  0x6a ___#fx_off

    FOR (___#index1 = 0 ; ___#index1 < ___#abil_num ; ___#index1 = ___#index1 + 1) BEGIN //cycling through extended headers
      READ_SHORT (___#abil_off + 0x1e + (0x28 * ___#index1)) ___#abil_fx_num
      READ_SHORT (___#abil_off + 0x20 + (0x28 * ___#index1)) ___#abil_fx_idx

      FOR (___#index2 = ___#abil_fx_idx ; ___#index2 < (___#abil_fx_idx + ___#abil_fx_num) ; ___#index2 = ___#index2 + 1) BEGIN //cycling through ability\'s effects
        READ_SHORT (___#fx_off + 0x30 * ___#index2) ___#opcode
        PATCH_IF ( (___#opcode = opcode_to_delete) OR (opcode_to_delete = (0 - 1)) ) BEGIN //matched or we should delete all

          DELETE_BYTES (___#fx_off + 0x30 * ___#index2) 0x30
          SET ___#abil_fx_num = ___#abil_fx_num - 1 //for stopping cycle properly
          WRITE_SHORT (___#abil_off + 0x1e + (0x28 * ___#index1)) ___#abil_fx_num //correct number of effects in ability

          //correcting 1st effect ___#index1es
          FOR (___#index3 = 0 ; ___#index3 < ___#abil_num ; ___#index3 = ___#index3 + 1) BEGIN //cycling through abilities again
            READ_SHORT (___#abil_off + ___#index3 * 0x28 + 0x20) ___#1effect_index
            PATCH_IF (___#1effect_index > ___#index2) BEGIN //if next abilility
              WRITE_SHORT (___#abil_off + ___#index3 * 0x28 + 0x20) (___#1effect_index - 1) //decrease 1 effect ___#index1 by 1
            END
          END
          //no offsets to correct
          SET ___#index2 = ___#index2 - 1 //step back to not miss an effect
        END
      END

    END
  END
END



//deletes the extended effect with the specified opcode from the item. need parameters: opcode_to_delete
DEFINE_PATCH_MACRO ~DELETE_ITEM_EFFECT~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x71) THEN BEGIN
    READ_LONG  0x64 ___#abil_off
    READ_SHORT 0x68 ___#abil_num
    READ_LONG  0x6a ___#fx_off

    FOR (___#index1 = 0 ; ___#index1 < ___#abil_num ; ___#index1 = ___#index1 + 1) BEGIN //cycling through extended headers
//      READ_BYTE  (___#abil_off +        (___#index1 * 0x38)) ___#type
//      PATCH_IF (___#type = 3) BEGIN //if magical ability
        READ_SHORT (___#abil_off + 0x1e + (0x38 * ___#index1)) ___#abil_fx_num
        READ_SHORT (___#abil_off + 0x20 + (0x38 * ___#index1)) ___#abil_fx_idx
        FOR (___#index2 = ___#abil_fx_idx ; ___#index2 < (___#abil_fx_idx + ___#abil_fx_num) ; ___#index2 = ___#index2 + 1) BEGIN //cycling through ability\'s effects
          READ_SHORT (___#fx_off + 0x30 * ___#index2) ___#opcode
          PATCH_IF ( (___#opcode = opcode_to_delete) OR (opcode_to_delete = (0 - 1)) ) BEGIN //match of delete all
            DELETE_BYTES (___#fx_off + 0x30 * ___#index2) 0x30
            SET ___#abil_fx_num = ___#abil_fx_num - 1 //for stopping cycle properly
            WRITE_SHORT (___#abil_off + 0x1e + (0x38 * ___#index1)) ___#abil_fx_num //correct number of effects in ability

            //correcting 1st effect ___#index1es
            FOR (___#index3 = 0 ; ___#index3 < ___#abil_num ; ___#index3 = ___#index3 + 1) BEGIN //cycling through abilities again
              READ_SHORT (___#abil_off + ___#index3 * 0x38 + 0x20) ___#1effect_index
              PATCH_IF (___#1effect_index > ___#index2) BEGIN //if next abilility
                WRITE_SHORT (___#abil_off + ___#index3 * 0x38 + 0x20) (___#1effect_index - 1) //decrease 1 effect ___#index1 by 1
              END
            END
            //no offsets to correct
            SET ___#index2 = ___#index2 - 1 //step back to not miss an effect
          END
        END

//      END
    END

  END
END


//deletes the equipping effect the with specified opcode from the item. need parameters: opcode_to_delete
DEFINE_PATCH_MACRO ~DELETE_ITEM_EQEFFECT~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x71) THEN BEGIN
    READ_LONG 0x64 ___#abil_off
    READ_SHORT 0x68 ___#abil_num
    READ_LONG 0x6a ___#fx_off
    READ_SHORT 0x6e ___#eqfx_off
    READ_SHORT 0x70 ___#eqfx_num
    FOR (___#index1 = 0 ; ___#index1 < ___#eqfx_num ; ___#index1 = ___#index1 + 1) BEGIN //cycle though global effects
      READ_SHORT  (___#fx_off + (___#index1 + ___#eqfx_off) * 0x30) ___#opcode
      PATCH_IF ( (___#opcode = opcode_to_delete) OR (opcode_to_delete = (0 - 1)) ) BEGIN

        DELETE_BYTES (___#fx_off + (___#index1 + ___#eqfx_off) * 0x30) 0x30
        SET ___#eqfx_num = (___#eqfx_num - 1)
        WRITE_SHORT 0x70 ___#eqfx_num

        //correcting 1st effect indexes
        FOR (___#index2 = 0 ; ___#index2 < ___#abil_num ; ___#index2 = ___#index2 + 1) BEGIN
          READ_SHORT (___#abil_off + ___#index2 * 0x38 + 0x20) ___#1effect_index
          PATCH_IF (___#1effect_index > ___#index1) BEGIN //if abilility after current effect
            WRITE_SHORT (___#abil_off + ___#index2 * 0x38 + 0x20) (___#1effect_index - 1) //decrease 1 effect ___#index1 by 1
          END
        END
        //no offsets to correct
        SET ___#index1 = (___#index1 - 1)
      END
    END //end of searching
  END
END



//adds an extended effect to a specified spell
//essential parameters:
//opcode
//target
//timing

//optional parameters:
//resist_dispel (magic resitance/dispel type)
//power
//parameter1
//parameter2
//duration
//probability1 (default 100)
//probability2 (default 0)
//resource (ascii string 8 chars)
//dicenumber
//dicesize
//savingthrow
//savebonus
//header (default all)
//insert_point (last by default)

DEFINE_PATCH_MACRO ~ADD_SPELL_EFFECT~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x71) THEN BEGIN
    READ_LONG  0x64 ___#abil_off
    READ_SHORT 0x68 ___#abil_num
    READ_LONG  0x6a ___#fx_off

    FOR (___#index1 = 0 ; ___#index1 < ___#abil_num ; ___#index1 = ___#index1 + 1) BEGIN

      PATCH_IF (___#index1 = (header - 1)) OR (header = 0) BEGIN //header=1 means ___#index1=0
        READ_SHORT  (___#abil_off + 0x1e + (0x28 * ___#index1)) ___#abil_fx_num
        READ_SHORT  (___#abil_off + 0x20 + (0x28 * ___#index1)) ___#abil_fx_idx

        ___#insert_point = !VARIABLE_IS_SET insert_point OR !IS_AN_INT insert_point OR insert_point < 0 OR insert_point > ___#abil_fx_num ? ___#abil_fx_num : insert_point

        INSERT_BYTES (___#fx_off +        (0x30 * (___#insert_point + ___#abil_fx_idx))) 0x30

        WRITE_SHORT  (___#fx_off +        (0x30 * (___#insert_point + ___#abil_fx_idx))) opcode
        WRITE_BYTE   (___#fx_off + 0x02 + (0x30 * (___#insert_point + ___#abil_fx_idx))) target
        WRITE_BYTE   (___#fx_off + 0x03 + (0x30 * (___#insert_point + ___#abil_fx_idx))) power
        WRITE_LONG   (___#fx_off + 0x04 + (0x30 * (___#insert_point + ___#abil_fx_idx))) parameter1
        WRITE_LONG   (___#fx_off + 0x08 + (0x30 * (___#insert_point + ___#abil_fx_idx))) parameter2
        WRITE_BYTE   (___#fx_off + 0x0c + (0x30 * (___#insert_point + ___#abil_fx_idx))) timing
        WRITE_BYTE   (___#fx_off + 0x0d + (0x30 * (___#insert_point + ___#abil_fx_idx))) resist_dispel
        WRITE_LONG   (___#fx_off + 0x0e + (0x30 * (___#insert_point + ___#abil_fx_idx))) duration
        WRITE_BYTE   (___#fx_off + 0x12 + (0x30 * (___#insert_point + ___#abil_fx_idx))) probability1
        WRITE_BYTE   (___#fx_off + 0x13 + (0x30 * (___#insert_point + ___#abil_fx_idx))) probability2
        WRITE_EVALUATED_ASCII (___#fx_off + 0x14 + (0x30 * (___#insert_point + ___#abil_fx_idx))) ~%resource%~ #8
        WRITE_LONG   (___#fx_off + 0x1c + (0x30 * (___#insert_point + ___#abil_fx_idx))) dicenumber
        WRITE_LONG   (___#fx_off + 0x20 + (0x30 * (___#insert_point + ___#abil_fx_idx))) dicesize
        WRITE_LONG   (___#fx_off + 0x24 + (0x30 * (___#insert_point + ___#abil_fx_idx))) savingthrow
        WRITE_LONG   (___#fx_off + 0x28 + (0x30 * (___#insert_point + ___#abil_fx_idx))) savebonus
        PATCH_IF IS_AN_INT ___#special BEGIN
          WRITE_LONG (___#fx_off + 0x2c + (0x30 * (___#insert_point + ___#abil_fx_idx))) ___#special
        END

        //correcting effects number
        WRITE_SHORT (___#abil_off + 0x1e + (0x28 * ___#index1)) (___#abil_fx_num + 1)

        //correcting 1st effect indexes
        FOR (___#index2 = 0 ; ___#index2 < ___#abil_num ; ___#index2 = ___#index2 + 1) BEGIN
          READ_SHORT (___#abil_off + ___#index2 * 0x28 + 0x20) ___#1effect_index
          PATCH_IF (___#1effect_index > ___#abil_fx_idx) //if abilility after current effect
                OR ((___#1effect_index = ___#abil_fx_idx)
                AND (___#abil_fx_num = 0)
                AND (___#index2 != ___#index1)) BEGIN
            WRITE_SHORT (___#abil_off + ___#index2 * 0x28 + 0x20) (___#1effect_index + 1) //increase 1 effect ___#index1 by 1
          END
        END
        //no offsets to correct
      END
    END
    //reset vars
    SET opcode = 0
    SET target = 0
    SET timing = 0
    SET resist_dispel = 0
    SET power = 0
    SET header = 0
    SET parameter1 = 0
    SET parameter2 = 0
    SET probability1 = 100
    SET probability2 = 0
    SET duration = 0
    SPRINT resource ~%___#nil%~
    SET dicenumber = 0
    SET dicesize = 0
    SET savingthrow = 0
    SET savebonus = 0

  END
END



//adds an equip effect to a specified item
//esessential parameters:
//___#opcode
//target
//timing

//optional parameters:
//resist_dispel (magic resitance/dispel type)
//power
//parameter1
//parameter2
//duration
//probability1 (default 100)
//probability2 (default 0)
//resource (ascii string 8 chars max)
//dicenumber
//dicesize
//savingthrow
//savebonus

DEFINE_PATCH_MACRO ~ADD_ITEM_EQEFFECT~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x71) THEN BEGIN
    PATCH_IF (~%SOURCE_EXT%~ STRING_EQUAL_CASE ~spl~ = 1) BEGIN
      ___#hdr_size = 0x28
    END ELSE BEGIN
      ___#hdr_size = 0x38
    END
    READ_LONG 0x64 ___#abil_off
    READ_SHORT 0x68 ___#abil_num
    READ_LONG 0x6a ___#fx_off
    READ_SHORT 0x6e ___#eqfx_index
    READ_SHORT 0x70 ___#eqfx_num

    /* If insert_point is defined and valid, use it,
       if undefined, default to 0,
       otherwise, insert at the end
    */
    ___#insert_point = IS_AN_INT insert_point AND
                       insert_point >= 0 AND
                       insert_point < ___#eqfx_num ?
                       insert_point : !IS_AN_INT insert_point ? 0 : ___#eqfx_num

    INSERT_BYTES (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30) 0x30

    WRITE_SHORT  (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30) opcode
    WRITE_BYTE  (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x02) target

    WRITE_BYTE  (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x03) power
    WRITE_LONG   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x04) parameter1
    WRITE_LONG   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x08) parameter2
    WRITE_BYTE   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x0c) timing
    WRITE_BYTE   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x0d) resist_dispel
    WRITE_LONG   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x0e) duration
    WRITE_BYTE   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x12) probability1
    WRITE_BYTE   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x13) probability2
    WRITE_EVALUATED_ASCII (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x14) ~%resource%~ #8
    WRITE_LONG   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x1c) dicenumber
    WRITE_LONG   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x20) dicesize
    WRITE_LONG   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x24) savingthrow
    WRITE_LONG   (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x28) savebonus
    PATCH_IF IS_AN_INT ___#special BEGIN
      WRITE_LONG (___#fx_off + ___#eqfx_index + ___#insert_point * 0x30 + 0x2c) ___#special
    END

    //correcting global effects number
    WRITE_SHORT 0x70 (___#eqfx_num + 1)

    //correcting 1st effect ___#index1es
    FOR (___#index2 = 0 ; ___#index2 < ___#abil_num ; ___#index2 = ___#index2 + 1) BEGIN
      READ_SHORT (___#abil_off + ___#index2 * ___#hdr_size + 0x20) ___#1effect_index
      PATCH_IF (___#1effect_index > ___#eqfx_index) //if abilility after eq effects
            OR ((___#1effect_index = ___#eqfx_index) AND (___#eqfx_num = 0)) BEGIN
        WRITE_SHORT (___#abil_off + ___#index2 * ___#hdr_size + 0x20) (___#1effect_index + 1) //increase 1 effect ___#index1 by 1
      END
    END
    //no offsets to correct
  //reset vars
  SET opcode = 0
  SET target = 0
  SET timing = 0
  SET resist_dispel = 0
  SET power = 0
  SET parameter1 = 0
  SET parameter2 = 0
  SET duration = 0
  SET probability1 = 100
  SET probability2 = 0
  SPRINT resource ~%___#nil%~
  SET dicenumber = 0
  SET dicesize = 0
  SET savingthrow = 0
  SET savebonus = 0

  END
END

DEFINE_PATCH_MACRO ~ADD_SPELL_CFEFFECT~ BEGIN
  LAUNCH_PATCH_MACRO ~ADD_ITEM_EQEFFECT~
END



//adds the effect to the item. Need parameters: ___#opcode target use_level fail_strref timing mr_bypass duration probability ~%resource%~
DEFINE_PATCH_MACRO ~ADD_ITEM_EFFECT~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x71) THEN BEGIN // protects against invalid files
    READ_LONG   0x64 ___#abil_off //ability offset
    READ_SHORT  0x68 ___#abil_num //number of abilities
    READ_LONG   0x6a ___#fx_off //effects offset
    FOR (___#index1 = 0 ; ___#index1 < ___#abil_num ; ___#index1 = ___#index1 + 1) BEGIN // looks for magical ability header
      READ_BYTE  (___#abil_off +        (___#index1 * 0x38)) ___#type //ability type
      PATCH_IF ((!(VARIABLE_IS_SET type AND IS_AN_INT type) && ___#type = 3) OR (VARIABLE_IS_SET type AND IS_AN_INT type AND ((___#type = type) OR type = 99))) AND ((___#index1 = (header - 1)) OR (header = 0)) BEGIN //ability is correct or unspecified and header matches
        READ_SHORT  (___#abil_off + 0x1e + (0x38 * ___#index1)) ___#abil_fx_num
        READ_SHORT  (___#abil_off + 0x20 + (0x38 * ___#index1)) ___#abil_fx_idx

        ___#insert_point = !VARIABLE_IS_SET insert_point OR !IS_AN_INT insert_point OR insert_point < 0 OR insert_point > ___#abil_fx_num ? ___#abil_fx_num : insert_point

        INSERT_BYTES (___#fx_off +        (0x30 * (___#insert_point + ___#abil_fx_idx))) 0x30

        WRITE_SHORT  (___#fx_off +        (0x30 * (___#insert_point + ___#abil_fx_idx))) opcode
        WRITE_BYTE   (___#fx_off + 0x02 + (0x30 * (___#insert_point + ___#abil_fx_idx))) target
        WRITE_BYTE   (___#fx_off + 0x03 + (0x30 * (___#insert_point + ___#abil_fx_idx))) power
        WRITE_LONG   (___#fx_off + 0x04 + (0x30 * (___#insert_point + ___#abil_fx_idx))) parameter1
        WRITE_LONG   (___#fx_off + 0x08 + (0x30 * (___#insert_point + ___#abil_fx_idx))) parameter2
        WRITE_BYTE   (___#fx_off + 0x0c + (0x30 * (___#insert_point + ___#abil_fx_idx))) timing
        WRITE_BYTE   (___#fx_off + 0x0d + (0x30 * (___#insert_point + ___#abil_fx_idx))) resist_dispel
        WRITE_LONG   (___#fx_off + 0x0e + (0x30 * (___#insert_point + ___#abil_fx_idx))) duration
        WRITE_BYTE   (___#fx_off + 0x12 + (0x30 * (___#insert_point + ___#abil_fx_idx))) probability1
        WRITE_BYTE   (___#fx_off + 0x13 + (0x30 * (___#insert_point + ___#abil_fx_idx))) probability2
        WRITE_EVALUATED_ASCII (___#fx_off + 0x14 + (0x30 * (___#insert_point + ___#abil_fx_idx))) ~%resource%~ #8
        WRITE_LONG   (___#fx_off + 0x1c + (0x30 * (___#insert_point + ___#abil_fx_idx))) dicenumber
        WRITE_LONG   (___#fx_off + 0x20 + (0x30 * (___#insert_point + ___#abil_fx_idx))) dicesize
        WRITE_LONG   (___#fx_off + 0x24 + (0x30 * (___#insert_point + ___#abil_fx_idx))) savingthrow
        WRITE_LONG   (___#fx_off + 0x28 + (0x30 * (___#insert_point + ___#abil_fx_idx))) savebonus
        PATCH_IF IS_AN_INT ___#special BEGIN
          WRITE_LONG (___#fx_off + 0x2c + (0x30 * (___#insert_point + ___#abil_fx_idx))) ___#special
        END

        //correcting effects number
        WRITE_SHORT (___#abil_off + 0x1e + (0x38 * ___#index1)) (___#abil_fx_num + 1)

        //correcting 1st effect ___#index1es
        FOR (___#index2 = 0 ; ___#index2 < ___#abil_num ; ___#index2 = ___#index2 + 1) BEGIN
          READ_SHORT (___#abil_off + ___#index2 * 0x38 + 0x20) ___#1effect_index
          PATCH_IF (___#1effect_index > ___#abil_fx_idx) //if next abilility
                OR ((___#1effect_index = ___#abil_fx_idx)
                AND (___#abil_fx_num = 0)
                AND (___#index2 != ___#index1)) BEGIN
            WRITE_SHORT (___#abil_off + ___#index2 * 0x38 + 0x20) (___#1effect_index + 1) //increase 1 effect ___#index1 by 1
          END
        END
        //no offsets to correct
      END
    END //end of cycle

    //reset vars
    SET opcode = 0
    SET target = 0
    SET timing = 0
    SET resist_dispel = 0
    SET power = 0
    SET parameter1 = 0
    SET parameter2 = 0
    SET duration = 0
    SET probability1 = 100
    SET probability2 = 0
    SPRINT resource ~%___#nil%~
    SET dicenumber = 0
    SET dicesize = 0
    SET savingthrow = 0
    SET savebonus = 0
  END
END





//add an effect to a creature.
//essential parameters:
//opcode
//target
//timing

//optional parameters:
//resist_dispel (magic resitance/dispel type)
//power
//parameter1
//parameter2
//duration
//probability1 (default 100)
//probability2 (default 0)
//resource (ascii string 8 chars)
//dicenumber
//dicesize
//savingthrow
//savebonus
//school
//lowestafflvl
//highestafflvl
//parameter3
//parameter4
//vvcresource (ascii string 8 chars)
//resource2 (ascii string 8 chars)
//casterx
//castery
//targetx
//targety
//effsource (ascii string 8 chars)
//effvar (ascii string 32 chars)
//casterlvl
//sectype

DEFINE_PATCH_MACRO ~ADD_CRE_EFFECT~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN
    READ_ASCII 0 __#signature
    READ_BYTE 0x33 __#effVersion
    PATCH_IF ~%__#signature%~ STRING_COMPARE_CASE ~CRE V1.0~ THEN BEGIN
      INNER_ACTION BEGIN
        FAIL ~%__#signature% not supported in ADD_CRE_EFFECT~
      END
    END
    PATCH_IF __#effVersion = 1 BEGIN
      LAUNCH_PATCH_MACRO ~ADD_CRE_EFFECT_BG2~
    END ELSE PATCH_IF __#effVersion = 0 BEGIN
      LAUNCH_PATCH_MACRO ~ADD_CRE_EFFECT_BG1~
    END
  END
END

DEFINE_PATCH_MACRO ~ADD_CRE_EFFECT_BG1~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN
    READ_ASCII 0 __#signature
    READ_BYTE 0x33 __#effVersion
    PATCH_IF ~%__#signature%~ STRING_COMPARE_CASE ~CRE V1.0~ THEN BEGIN
      INNER_ACTION BEGIN
        FAIL ~%__#signature% not supported in ADD_CRE_EFFECT_BG1~
      END
    END
    PATCH_IF __#effVersion != 0 BEGIN
      INNER_ACTION BEGIN
        FAIL ~ADD_CRE_EFFECT_BG1 and EFF version is %__#effVersion%~
      END
    END


    READ_LONG 0x2c4 ___#fx_off
    READ_LONG 0x2c8 ___#fx_num

    /* If insert_point is greater than or equal to 0 and less than num_fx, use it as a value
     * Otherwise, insert at num_fx
     * The function should use 0 as its default value
     */
    ___#insert_point = IS_AN_INT insert_point AND
                       insert_point >= 0 AND
                       insert_point < ___#fx_num ?
                       insert_point : ___#fx_num

    INSERT_BYTES ___#fx_off + ___#insert_point * 0x30 0x30

    WRITE_SHORT (___#fx_off + ___#insert_point * 0x30) opcode
    WRITE_BYTE (___#fx_off + ___#insert_point * 0x30 + 0x2) target
    WRITE_BYTE (___#fx_off + ___#insert_point * 0x30 + 0x3) power
    WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0x4) parameter1
    WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0x8) parameter2
    WRITE_BYTE (___#fx_off + ___#insert_point * 0x30 + 0xc) timing
    WRITE_BYTE (___#fx_off + ___#insert_point * 0x30 + 0xd) resist_dispel
    WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0xe) duration
    WRITE_BYTE (___#fx_off + ___#insert_point * 0x30 + 0x12) probability1
    WRITE_BYTE (___#fx_off + ___#insert_point * 0x30 + 0x13) probability2
    WRITE_EVALUATED_ASCII (___#fx_off + ___#insert_point * 0x30 + 0x14) ~%resource%~ #8
    WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0x1c) dicenumber
    WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0x20) dicesize
    WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0x24) savingthrow
    WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0x28) savebonus
    PATCH_IF IS_AN_INT ___#special BEGIN
      WRITE_LONG (___#fx_off + ___#insert_point * 0x30 + 0x2c) ___#special
    END

    //correcting effects number
    WRITE_LONG 0x2c8 (___#fx_num + 1)

     //correcting offsets
    PATCH_FOR_EACH ___#offset IN 0x2b8 0x2bc BEGIN //item num and islot
      READ_LONG ___#offset ___#current_off
      WRITE_LONG ___#offset (___#current_off + 0x30)
    END

    //reset vars
    SET opcode = 0
    SET target = 0
    SET power = 0
    SET parameter1 = 0
    SET parameter2 = 0
    SET timing = 0
    SET resist_dispel = 0
    SET duration = 0
    SET probability1 = 100
    SET probability2 = 0
    SPRINT resource ~%___#nil%~
    SET dicenumber = 0
    SET dicesize = 0
    SET savingthrow = 0
    SET savebonus = 0
  END
END

DEFINE_PATCH_MACRO ~ADD_CRE_EFFECT_BG2~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN
    READ_ASCII 0 __#signature
    READ_BYTE 0x33 __#effVersion
    PATCH_IF ~%__#signature%~ STRING_COMPARE_CASE ~CRE V1.0~ THEN BEGIN
      INNER_ACTION BEGIN
        FAIL ~%__#signature% not supported in ADD_CRE_EFFECT_BG2~
      END
    END
    PATCH_IF __#effVersion != 1 BEGIN
      INNER_ACTION BEGIN
        FAIL ~ADD_CRE_EFFECT_BG2 and EFF version is %__#effVersion%~
      END
    END

    PATCH_IF !VARIABLE_IS_SET restype BEGIN
      SET restype = 0
    END
    PATCH_IF !VARIABLE_IS_SET sourceslot BEGIN
      SET sourceslot = \"-1\"
    END

    READ_LONG 0x2c4 ___#fx_off
    READ_LONG 0x2c8 ___#fx_num

    /* If insert_point is greater than or equal to 0 and less than num_fx, use it as a value
     * Otherwise, insert at num_fx
     * The function should use 0 as its default value
     */
    ___#insert_point = IS_AN_INT insert_point AND
                       insert_point >= 0 AND
                       insert_point < ___#fx_num ?
                       insert_point : ___#fx_num

    INSERT_BYTES ___#fx_off + ___#insert_point * 0x108 0x108

//    WRITE_ASCII ___#fx_off + ___#insert_point * 0x108 ~EFF ~ #4
//    WRITE_ASCII (___#fx_off + ___#insert_point * 0x108 + 4) ~V2.0~ #4

    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x8) opcode
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0xc) target
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x10) power
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x14) parameter1
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x18) parameter2
    WRITE_BYTE (___#fx_off + ___#insert_point * 0x108 + 0x1c) timing
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x20) duration
    WRITE_SHORT (___#fx_off + ___#insert_point * 0x108 + 0x24) probability1
    WRITE_SHORT (___#fx_off + ___#insert_point * 0x108 + 0x26) probability2
    WRITE_EVALUATED_ASCII (___#fx_off + ___#insert_point * 0x108 + 0x28) ~%resource%~ #8
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x30) dicenumber
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x34) dicesize
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x38) savingthrow
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x3c) savebonus
    PATCH_IF IS_AN_INT ___#special BEGIN
      WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x40) ___#special
    END
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x44) school
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x4c) lowestafflvl
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x50) highestafflvl
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x54) resist_dispel
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x58) parameter3
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x5c) parameter4
    WRITE_EVALUATED_ASCII (___#fx_off + ___#insert_point * 0x108 + 0x68) ~%vvcresource%~ #8
    WRITE_EVALUATED_ASCII (___#fx_off + ___#insert_point * 0x108 + 0x70) ~%resource2%~ #8
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x78) casterx
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x7c) castery
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x80) targetx
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0x84) targety
    WRITE_LONG  ___#fx_off + ___#insert_point * 0x108 + 0x88  restype
    WRITE_EVALUATED_ASCII (___#fx_off + ___#insert_point * 0x108 + 0x8c) ~%effsource%~ #8
    WRITE_LONG  ___#fx_off + ___#insert_point * 0x108 + 0x9c  sourceslot
    WRITE_EVALUATED_ASCII (___#fx_off + ___#insert_point * 0x108 + 0xa0) ~%effvar%~ #32
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0xc0) casterlvl
    WRITE_LONG (___#fx_off + ___#insert_point * 0x108 + 0xc8) sectype

    //correcting effects number
    WRITE_LONG 0x2c8 (___#fx_num + 1)

    //correcting offsets
    PATCH_FOR_EACH ___#offset IN 0x2b8 0x2bc BEGIN //item num and islot
      READ_LONG ___#offset ___#current_off
      WRITE_LONG ___#offset (___#current_off + 0x108)
    END

    //reset vars
    SET opcode = 0
    SET target = 0
    SET timing = 0
    SET power = 0
    SET parameter1 = 0
    SET parameter2 = 0
    SET timing = 0
    SET resist_dispel = 0
    SET duration = 0
    SET probability1 = 100
    SET probability2 = 0
    SPRINT resource ~%___#nil%~
    SET dicenumber = 0
    SET dicesize = 0
    SET savingthrow = 0
    SET savebonus = 0
    SET school = 0
    SET lowestafflvl = 0
    SET highestafflvl = 0
    SET parameter3 = 0
    SET parameter4 = 0
    SPRINT vvcresource ~%___#nil%~
    SPRINT resource2 ~%___#nil%~
    SET casterx = 0 - 1
    SET castery = 0 - 1
    SET targetx = 0 - 1
    SET targety = 0 - 1
    SET restype = 0
    SPRINT effsource ~%___#nil%~
    SET sourceslot = \"-1\"
    SPRINT effvar ~%___#nil%~
    SET casterlvl = 0
    SET sectype = 0
  END
END

//deletes all effects with spec. opcode from a creature.
//essential parameters:
//opcode_to_delete
DEFINE_PATCH_MACRO ~DELETE_CRE_EFFECT~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN

    READ_BYTE 0x33  ___#fx_flag
    READ_LONG 0x2c4 ___#fx_off
    READ_LONG 0x2c8 ___#fx_num
    SET ___#delta = 0
    FOR (___#index1 = 0; ___#index1 < ___#fx_num; ___#index1 = ___#index1 + 1) BEGIN
      PATCH_IF ___#fx_flag = 0 BEGIN
        READ_SHORT (___#fx_off + ___#index1 * 0x30) ___#opcode
      END ELSE BEGIN
        READ_LONG (___#fx_off + ___#index1 * 0x108 + 8) ___#opcode
      END
      PATCH_IF ((___#opcode = opcode_to_delete) OR (opcode_to_delete = (0 - 1))) BEGIN
        DELETE_BYTES (___#fx_off + ___#index1 * (___#fx_flag = 1 ? 0x108 : 0x30)) ___#fx_flag = 1 ? 0x108 : 0x30
        SET ___#delta = ___#delta + 1 //track deleted number
        SET ___#fx_num = ___#fx_num - 1 //decrease effects number to stop cycle properly
        SET ___#index1 = ___#index1 - 1 //step back to not miss an effect
      END
    END
    //correcting offsets and number
    PATCH_IF (___#delta > 0) BEGIN
      WRITE_LONG 0x2c8 ___#fx_num //corrected earlier
      PATCH_FOR_EACH ___#offset IN 0x2a0 0x2a8 0x2b0 0x2b8 0x2bc BEGIN
        READ_LONG ___#offset ___#current_off
        PATCH_IF ___#current_off > ___#fx_off BEGIN
          WRITE_LONG ___#offset (___#current_off - ___#delta * (___#fx_flag = 1 ? 0x108 : 0x30))
        END
      END
    END

  END
END





//deletes all instances of ~item_to_delete~ at current creature
DEFINE_PATCH_MACRO ~DELETE_CRE_ITEM~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN
    READ_LONG 0x2bc ___#itm_off
    READ_LONG 0x2c0 ___#itm_num
    READ_LONG 0x2b8 ___#islot_off
    SET ___#delta = 0
    FOR (___#cur_itm = 0; ___#cur_itm < ___#itm_num; ___#cur_itm = (___#cur_itm + 1)) BEGIN
    READ_ASCII (___#itm_off + (___#cur_itm * 0x14)) ~item~
      PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%item_to_delete%~ = 0) THEN BEGIN

        DELETE_BYTES (___#itm_off + (___#cur_itm * 0x14)) 0x14
        SET ___#itm_num = ___#itm_num - 1

        //correct offsets
        PATCH_FOR_EACH ___#offset IN 0x2a0 0x2a8 0x2b0 0x2b8 0x2bc BEGIN
          READ_LONG ___#offset ___#current_off
          PATCH_IF ___#current_off > ___#itm_off BEGIN
            WRITE_LONG ___#offset (___#current_off - 0x14)
          END
        END

        FOR (___#cur_slot = 0; ___#cur_slot < 37; ___#cur_slot = ___#cur_slot + 1) BEGIN
          READ_LONG 0x2b8 ___#islot_off
          READ_SHORT  (___#islot_off + ___#cur_slot * 2) ___#itm_index
          PATCH_IF (___#itm_index = ___#cur_itm) BEGIN //if slot with deleted item
            WRITE_SHORT  (___#islot_off + ___#cur_slot * 2) 0xffff //nullify reference
          END
          PATCH_IF ((___#itm_index > ___#cur_itm) AND NOT (___#itm_index = 0xffff)) BEGIN //if next slot and not empty
            WRITE_SHORT  (___#islot_off + ___#cur_slot * 2) (___#itm_index - 1) //shift items back
          END
        END

        SET ___#cur_itm = ___#cur_itm - 1 //step back to not miss an item
      END
    END
    //correcting number
    WRITE_LONG  0x02c0 ___#itm_num
    //no offsets to correct

  END
END


//adds an item in an area.
//required: container_to_add_to (starting from 1), ~item_to_add~
//optional: charges1 charges2 charges3 flags
DEFINE_PATCH_MACRO ~ADD_AREA_ITEM~ BEGIN
  LOCAL_SET FL#ADD_AREA_ITEM#FLAGS = 0
  charges1 = VARIABLE_IS_SET charges1 AND IS_AN_INT charges1 ? charges1 : 0
  charges2 = VARIABLE_IS_SET charges2 AND IS_AN_INT charges2 ? charges2 : 0
  charges3 = VARIABLE_IS_SET charges3 AND IS_AN_INT charges3 ? charges3 : 0
  PATCH_IF VARIABLE_IS_SET flags AND \"%flags%\" STRING_CONTAINS_REGEXP \"identified\" = 0 BEGIN
    FL#ADD_AREA_ITEM#FLAGS |= BIT0
  END
  PATCH_IF VARIABLE_IS_SET flags AND \"%flags%\" STRING_CONTAINS_REGEXP \"unstealable\" = 0 BEGIN
    FL#ADD_AREA_ITEM#FLAGS |= BIT1
  END
  PATCH_IF VARIABLE_IS_SET flags AND \"%flags%\" STRING_CONTAINS_REGEXP \"stolen\" = 0 BEGIN
    FL#ADD_AREA_ITEM#FLAGS |= BIT2
  END
  PATCH_IF VARIABLE_IS_SET flags AND \"%flags%\" STRING_CONTAINS_REGEXP \"undroppable\" = 0 BEGIN
    FL#ADD_AREA_ITEM#FLAGS |= BIT3
  END
  LPF fj_are_structure
    INT_VAR
      fj_con_itm_idx = container_to_add_to - 1
      fj_charge0 = charges1
      fj_charge1 = charges2
      fj_charge2 = charges3
      fj_flags = FL#ADD_AREA_ITEM#FLAGS
    STR_VAR
      fj_structure_type = ~itm~
      fj_name = EVAL ~%item_to_add%~
  END
  //setting optional vars back to default
  SET charges1 = 0
  SET charges2 = 0
  SET charges3 = 0
  SPRINT flags ~~
END

//deletes an item from a store. ~item_to_delete~ required
DEFINE_PATCH_MACRO ~DELETE_STORE_ITEM~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x9a) BEGIN
    READ_ASCII 0x00 ___#sig (8)
    READ_LONG 0x34 ___#4sale_off
    READ_LONG 0x38 ___#4sale_num
    READ_LONG 0x2c ___#items_purchased_off
    READ_LONG 0x70 ___#cures_off
    SET ___#index1 = 0
    SET ___#delta = 0
    SET ___#4sale_size = (~%___#sig%~ STRING_EQUAL ~STORV1.1~) ? 0x58 : 0x1c

    WHILE (___#index1 < ___#4sale_num) BEGIN //searching through items
      READ_ASCII (___#4sale_off + (___#index1 * ___#4sale_size)) ~item~
      PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%item_to_delete%~ = 0) BEGIN
        DELETE_BYTES (___#4sale_off + (___#index1 * ___#4sale_size)) ___#4sale_size
        SET ___#delta = (___#delta + 1)
        SET ___#index1 = (___#index1 - 1) //step back
        SET ___#4sale_num = (___#4sale_num - 1)

      END
      SET ___#index1 = (___#index1 + 1)
    END

    //correct number
    WRITE_LONG 0x38 ___#4sale_num

    //correcting offsets
    PATCH_FOR_EACH ___#offset IN 0x2c 0x70 BEGIN
      READ_LONG ___#offset ___#current_off
      PATCH_IF (___#current_off > ___#4sale_off) BEGIN
        WRITE_LONG ___#offset (___#current_off - ___#delta * ___#4sale_size)
      END
    END

  END
END


//deletes an item from the current area. ~item_to_delete~
DEFINE_PATCH_MACRO ~DELETE_AREA_ITEM~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x11b) BEGIN
    //reading necessary offsets
    READ_LONG 0x70 ___#cont_off
    READ_SHORT 0x74 ___#cont_num
    READ_LONG 0x78 ___#itm_off
    READ_SHORT 0x76 ___#itm_num
    SET ___#delta = 0

    FOR (___#index1 = 0; ___#index1 < ___#cont_num; ___#index1 = (___#index1 + 1)) BEGIN //searching through containers
      READ_LONG (___#cont_off + ___#index1 * 0xc0 + 0x44) ___#cont_items_num  //number ot items in container
      READ_LONG (___#cont_off + ___#index1 * 0xc0 + 0x40) ___#cont_item_index //first item ___#index1

      FOR (___#index2 = ___#cont_item_index ; ___#index2 < (___#cont_item_index + ___#cont_items_num) ; ___#index2 = ___#index2 + 1) BEGIN //cycling through container\'s items
        READ_ASCII (___#itm_off + (___#index2 * 0x14)) ~item~

        PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%item_to_delete%~ = 0) BEGIN
          DELETE_BYTES (___#itm_off + (___#index2 * 0x14)) 0x14
          SET ___#itm_num = (___#itm_num - 1) //for terminating the cycle properly
          SET ___#delta = (___#delta + 1) //for final adjusting offsets

          //correct ___#cont_off on the fly if need
          PATCH_IF (___#cont_off > ___#itm_off) BEGIN
            SET ___#cont_off = (___#cont_off - 0x14)
            WRITE_LONG 0x70 ___#cont_off
          END

          //correct number of items in container
          SET ___#cont_items_num = (___#cont_items_num - 1)
          WRITE_LONG (___#cont_off + ___#index1 * 0xc0 + 0x44) ___#cont_items_num

          //adjusting 1 item indexes
          FOR (___#index3 = 0; ___#index3 < ___#cont_num; ___#index3 = ___#index3 + 1 ) BEGIN //searching through containers
            READ_LONG (___#cont_off + ___#index3 * 0xc0 + 0x40) ___#1item_index //first item ___#index1
            PATCH_IF (___#1item_index > ___#index2) BEGIN //if one of next containers
              WRITE_LONG (___#cont_off + ___#index3 * 0xc0 + 0x40) (___#1item_index - 1) //decrease first item ___#index1 by 1
            END
          END

          SET ___#index2 = (___#index2 - 1) //step back to not miss items
        END

      END

    END

    //correcting offsets (0x70 is already fixed, 0x78 - items offset)
    PATCH_FOR_EACH ___#offset IN 0x54 0x5c 0x60 0x68 0x7c 0x84 0x88 0xa0 0xa8 0xb0 0xb8 0xbc 0xc0 0xc4 0xcc BEGIN
      READ_LONG ___#offset ___#current_off
      PATCH_IF (___#current_off > ___#itm_off) BEGIN
        WRITE_LONG ___#offset (___#current_off - ___#delta * 0x14)
      END
    END

    //correcting total items number
    WRITE_SHORT 0x76 ___#itm_num

  END
END

//replace item in .sto. variables ~old_item~ ~new_item~ required number_in_stock
DEFINE_PATCH_MACRO ~REPLACE_STORE_ITEM~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x9a) BEGIN
    READ_ASCII 0x00 ___#sig (8)
    READ_LONG 0x34 ___#4sale_off
    READ_LONG 0x38 ___#4sale_num
    SET ___#4sale_size = (~%___#sig%~ STRING_EQUAL ~STORV1.1~) ? 0x58 : 0x1c

    WHILE (___#4sale_num > 0) BEGIN
      SET ___#4sale_num = (___#4sale_num - 1)
      READ_ASCII (___#4sale_off + (___#4sale_num * ___#4sale_size)) ~item~
      PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%old_item%~ = 0) BEGIN
        WRITE_EVALUATED_ASCII (___#4sale_off + (___#4sale_num * ___#4sale_size)) ~%new_item%~ #8 // replace item

        //charges:
        WRITE_SHORT (___#4sale_off + (___#4sale_num * ___#4sale_size + 0xa)) charges1
        WRITE_SHORT (___#4sale_off + (___#4sale_num * ___#4sale_size + 0xc)) charges2
        WRITE_SHORT (___#4sale_off + (___#4sale_num * ___#4sale_size + 0xe)) charges3

        //flags
        SET ___#flags_to_set = 0
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~identified~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00000001)
        END
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~unstealable~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00000010)
        END
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~stolen~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00000100)
        END
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~undroppable~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00001000)
        END
        WRITE_LONG (___#4sale_off + ___#4sale_num * ___#4sale_size + 0x10) ___#flags_to_set

        WRITE_BYTE (___#4sale_off + 0x14 + ___#4sale_size * ___#4sale_num) number_in_stock

        WRITE_BYTE (___#4sale_off + 0x18 + ___#4sale_size * ___#4sale_num) 0 // Set infinite flag to zero

      END
    END

  END

  SET number_in_stock = 1
  SET charges1 = 0
  SET charges2 = 0
  SET charges3 = 0
  SPRINT flags ~%___#nil%~
END



//replaces item in an area with another item. Variables ~old_item~, ~new_item~ required
DEFINE_PATCH_MACRO ~REPLACE_AREA_ITEM~ BEGIN
  PATCH_IF (BUFFER_LENGTH > 0x11b) BEGIN
    READ_SHORT 0x76 ___#itm_num
    READ_LONG  0x78 ___#itm_off
    WHILE (___#itm_num > 0) BEGIN
      SET ___#itm_num = (___#itm_num - 1)
      READ_ASCII (___#itm_off + (___#itm_num * 0x14)) ~item~
      PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%old_item%~ = 0) BEGIN
        WRITE_EVALUATED_ASCII (___#itm_off + (___#itm_num * 0x14)) ~%new_item%~ #8

        //charges:
        WRITE_SHORT (___#itm_off + ___#itm_num * 0x14 + 0xa) charges1
        WRITE_SHORT (___#itm_off + ___#itm_num * 0x14 + 0xc) charges2
        WRITE_SHORT (___#itm_off + ___#itm_num * 0x14 + 0xe) charges3

        //flags
        SET ___#flags_to_set = 0
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~identified~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00000001)
        END
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~unstealable~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00000010)
        END
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~stolen~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00000100)
        END
        PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~undroppable~ = 0) BEGIN
          SET ___#flags_to_set = (___#flags_to_set BOR 0b00001000)
        END
        WRITE_LONG (___#itm_off + ___#itm_num * 0x14 + 0x10) ___#flags_to_set

      END
    END
  END
  SET charges1 = 0
  SET charges2 = 0
  SET charges3 = 0
  SPRINT flags ~%___#nil%~
END



//adds flags to an item possessed by a specified creature. variables ~item_to_change~, ~flags~ required
DEFINE_PATCH_MACRO ~ADD_CRE_ITEM_FLAGS~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN
    READ_LONG  0x2bc ___#itm_off
    READ_LONG  0x2c0 ___#itm_num

    SET ___#flags_to_add = 0

    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~identified~ = 0) BEGIN
      SET ___#flags_to_add = (___#flags_to_add BOR 0b00000001)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~unstealable~ = 0) BEGIN
      SET ___#flags_to_add = (___#flags_to_add BOR 0b00000010)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~stolen~ = 0) BEGIN
      SET ___#flags_to_add = (___#flags_to_add BOR 0b00000100)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~undroppable~ = 0) BEGIN
      SET ___#flags_to_add = (___#flags_to_add BOR 0b00001000)
    END

    WHILE (___#itm_num > 0) BEGIN
      SET ___#itm_num = (___#itm_num - 1)
      READ_ASCII (___#itm_off + (0x14 * ___#itm_num)) ~item~
      PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%item_to_change%~ = 0) BEGIN
        READ_BYTE   (___#itm_off + 0x10 + 0x14 * ___#itm_num) ___#current_flags
        WRITE_BYTE  (___#itm_off + 0x10 + 0x14 * ___#itm_num) (___#current_flags BOR ___#flags_to_add) // adds specified flags
      END
    END

  END
END



//removes flags from an item possessed by a specified creature. variables ~item_to_change~, ~___#flags_to_remove~ required
DEFINE_PATCH_MACRO ~REMOVE_CRE_ITEM_FLAGS~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN
    READ_LONG  0x2bc ___#itm_off
    READ_LONG  0x2c0 ___#itm_num

    //flags
    SET ___#flags_to_remove = 0b11111111

    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~identified~ = 0) BEGIN
      SET ___#flags_to_remove = (___#flags_to_remove BAND 0b11111110)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~unstealable~ = 0) BEGIN
      SET ___#flags_to_remove = (___#flags_to_remove BAND 0b11111101)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~stolen~ = 0) BEGIN
      SET ___#flags_to_remove = (___#flags_to_remove BAND 0b11111011)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~undroppable~ = 0) BEGIN
      SET ___#flags_to_remove = (___#flags_to_remove BAND 0b11110111)
    END

    WHILE (___#itm_num > 0) BEGIN
      SET ___#itm_num = (___#itm_num - 1)
      READ_ASCII (___#itm_off + (0x14 * ___#itm_num)) ~item~
      PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%item_to_change%~ = 0) BEGIN
        READ_BYTE   (___#itm_off + 0x10 + (0x14 * ___#itm_num)) ___#current_flags
        WRITE_BYTE  (___#itm_off + 0x10 + (0x14 * ___#itm_num)) (___#current_flags BAND ___#flags_to_remove) // removes specified flags
      END
    END

  END
END



//sets flags to an item possessed by a specified creature. variables ~item_to_change~, ~flags~ required
DEFINE_PATCH_MACRO ~SET_CRE_ITEM_FLAGS~ BEGIN
  LAUNCH_PATCH_FUNCTION ~FJ_CRE_VALIDITY~ RET valid = valid END
  PATCH_IF (valid) BEGIN
    READ_LONG  0x2bc ___#itm_off
    READ_LONG  0x2c0 ___#itm_num

    //flags
    SET ___#flags_to_set = 0b00000000
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~identified~ = 0) BEGIN
      SET ___#flags_to_set = (___#flags_to_set BOR 0b00000001)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~unstealable~ = 0) BEGIN
      SET ___#flags_to_set = (___#flags_to_set BOR 0b00000010)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~stolen~ = 0) BEGIN
      SET ___#flags_to_set = (___#flags_to_set BOR 0b00000100)
    END
    PATCH_IF (~%flags%~ STRING_CONTAINS_REGEXP ~undroppable~ = 0) BEGIN
      SET ___#flags_to_set = (___#flags_to_set BOR 0b00001000)
    END

    WHILE (___#itm_num > 0) BEGIN
      SET ___#itm_num = (___#itm_num - 1)
      READ_ASCII (___#itm_off + (0x14 * ___#itm_num)) ~item~
      PATCH_IF (~%item%~ STRING_MATCHES_REGEXP ~%item_to_change%~ = 0) BEGIN
        WRITE_BYTE  (___#itm_off + 0x10 + (0x14 * ___#itm_num)) ___#flags_to_set // set flags
      END
    END

  END
END



//input: npc (.cre), soundset (string)
//output: soundset_0-99 (100-int array of strrefs)
DEFINE_ACTION_MACRO ~READ_SOUNDSET~ BEGIN
  COPY_EXISTING ~%npc%~ ~override~
    PATCH_IF (BUFFER_LENGTH > 0x2d3) BEGIN
      FOR (___#index1 = 0; ___#index1 < 100; ___#index1 = ___#index1 + 1) BEGIN
        SET EVALUATE_BUFFER ~%soundset%_%___#index1%~ = (0 - 1)
      END
      FOR (___#index1 = 0; ___#index1 < 100; ___#index1 = ___#index1 + 1) BEGIN
        READ_LONG (0xa4 + ___#index1 * 4) ___#strref
        PATCH_IF NOT (___#strref = (0 - 1)) BEGIN
          SET EVALUATE_BUFFER ~%soundset%_%___#index1%~ = ___#strref
        END
      END
    END
  BUT_ONLY_IF_IT_CHANGES
END



//npc (.cre), overwrite (0 or 1), soundset (100-int array of strrefs)
DEFINE_ACTION_MACRO ~WRITE_SOUNDSET~ BEGIN
  COPY_EXISTING_REGEXP ~^%npc%$~ ~override~
    PATCH_IF (BUFFER_LENGTH > 0x2d3) BEGIN
      FOR (___#index1 = 0; ___#index1 < 100; ___#index1 = ___#index1 + 1) BEGIN
        READ_LONG (0xa4 + ___#index1 * 4) ___#strref
        SET ___#new_strref = EVALUATE_BUFFER ~%soundset%_%___#index1%~
        //soft writing
        PATCH_IF ((overwrite = 0) AND (___#strref = (0 - 1))) BEGIN
          WRITE_LONG (0xa4 + ___#index1 * 4) ___#new_strref
        END
        //forced writing
        PATCH_IF ((overwrite = 1) AND NOT (___#new_strref = (0 - 1))) BEGIN
          WRITE_LONG (0xa4 + ___#index1 * 4) ___#new_strref
        END
        //overwrite regardless of anything
        PATCH_IF (overwrite = 2) BEGIN
          WRITE_LONG (0xa4 + ___#index1 * 4) ___#new_strref
        END
      END
    END
  BUT_ONLY_IF_IT_CHANGES
END

DEFINE_PATCH_MACRO ~ADD_AREA_REGION_TRIGGER~ BEGIN
  LAUNCH_PATCH_MACRO ~ADD_AREA_REGION~
END

DEFINE_PATCH_MACRO ~ADD_AREA_REGION~ BEGIN
  FOR (i = 0; i < ab_RT_VxPr; ++i) BEGIN
    SET EVAL \"fj_vertex_%i%\" = EVAL \"ab_RT_Vx_X_%i%\" + (EVAL \"ab_RT_Vx_Y_%i%\" << 16)
  END
  /*
   * Safety-initialise all variables
   */
  ab_RT_Type = !IS_AN_INT ab_RT_Type ? 0 : ab_RT_Type
  ab_RT_BbLX = !IS_AN_INT ab_RT_BbLX ? 0 : ab_RT_BbLX
  ab_RT_BbLY = !IS_AN_INT ab_RT_BbLY ? 0 : ab_RT_BbLY
  ab_RT_BbHX = !IS_AN_INT ab_RT_BbHX ? 0 : ab_RT_BbHX
  ab_RT_BbHY = !IS_AN_INT ab_RT_BbHY ? 0 : ab_RT_BbHY
  ab_RT_CuId = !IS_AN_INT ab_RT_CuId ? 0 : ab_RT_CuId
  ab_RT_Fbit = !IS_AN_INT ab_RT_Fbit ? 0 : ab_RT_Fbit
  ab_RT_Itxt = !IS_AN_INT ab_RT_Itxt ? \"-1\" : ab_RT_Itxt
  ab_RT_TDtD = !IS_AN_INT ab_RT_TDtD ? 0 : ab_RT_TDtD
  ab_RT_TRmD = !IS_AN_INT ab_RT_TRmD ? 0 : ab_RT_TRmD
  ab_RT_TSet = !IS_AN_INT ab_RT_TSet ? 0 : ab_RT_TSet
  ab_RT_TDet = !IS_AN_INT ab_RT_TDet ? 0 : ab_RT_TDet
  ab_RT_LPoX = !IS_AN_INT ab_RT_LPoX ? 0 : ab_RT_LPoX
  ab_RT_LPoY = !IS_AN_INT ab_RT_LPoY ? 0 : ab_RT_LPoY
  ab_RT_ALPX = !IS_AN_INT ab_RT_ALPX ? 0 : ab_RT_ALPX
  ab_RT_ALPY = !IS_AN_INT ab_RT_ALPY ? 0 : ab_RT_ALPY
  PATCH_IF !VARIABLE_IS_SET ab_RT_Name BEGIN
    SPRINT ab_RT_Name \"\"
  END
  PATCH_IF !VARIABLE_IS_SET ab_RT_Dest BEGIN
    SPRINT ab_RT_Dest \"\"
  END
  PATCH_IF !VARIABLE_IS_SET ab_RT_EntN BEGIN
    SPRINT ab_RT_EntN \"\"
  END
  PATCH_IF !VARIABLE_IS_SET ab_RT_KeyI BEGIN
    SPRINT ab_RT_KeyI \"\"
  END
  PATCH_IF !VARIABLE_IS_SET ab_RT_Rbcs BEGIN
    SPRINT ab_RT_Rbcs \"\"
  END
  PATCH_IF !VARIABLE_IS_SET ab_RT_Dial BEGIN
    SPRINT ab_RT_Dial \"\"
  END
  LPF fj_are_structure
    INT_VAR
      fj_type = ab_RT_Type
      fj_box_left = ab_RT_BbLX
      fj_box_top = ab_RT_BbLY
      fj_box_right = ab_RT_BbHX
      fj_box_bottom = ab_RT_BbHY
      fj_cursor_idx = ab_RT_CuId
      fj_flags = ab_RT_Fbit
      fj_info_point_strref = ab_RT_Itxt
      fj_trap_detect = ab_RT_TDtD
      fj_trap_remove = ab_RT_TRmD
      fj_trap_active = ab_RT_TSet
      fj_trap_status = ab_RT_TDet
      fj_loc_x = ab_RT_LPoX
      fj_loc_y = ab_RT_LPoY
      fj_alt_x = ab_RT_ALPX
      fj_alt_y = ab_RT_ALPY
    STR_VAR
      fj_structure_type = region
      fj_name = EVAL ~%ab_RT_Name%~
      fj_destination_area = EVAL ~%ab_RT_Dest%~
      fj_destination_name = EVAL ~%ab_RT_EntN%~
      fj_key_resref = EVAL ~%ab_RT_KeyI%~
      fj_reg_script = EVAL ~%ab_RT_Rbcs%~
      fj_dialog = EVAL ~%ab_RT_Dial%~
  END
END
  ");
(".../WEIDU_NAMESPACE/handle_audio.tpa","DEFINE_ACTION_FUNCTION HANDLE_AUDIO
  INT_VAR
    music = 0
    quiet = 0
  STR_VAR
    audio_path = EVAL \"%MOD_FOLDER%/audio\"
    oggdec_path = EVAL \"%audio_path%\"
    sox_path = EVAL \"%audio_path%\"
    output_path = \"override\"
BEGIN
  /* Early versions of BG:EE do not include bgee.lua and
   * PST:EE does not include monkfist.2da
   */
  ACTION_IF !FILE_EXISTS_IN_GAME bgee.lua AND
            !FILE_EXISTS_IN_GAME monkfist.2da
  BEGIN
    ACTION_MATCH \"%WEIDU_OS%\" WITH
      win32
      BEGIN
        ACTION_IF FILE_EXISTS \"%oggdec_path%/oggdec.exe\" BEGIN
          ACTION_IF quiet BEGIN
            OUTER_SPRINT cli_quiet \"2>NUL\" // old oggdec does not have -Q
          END ELSE OUTER_SPRINT cli_quiet \"\"
          ACTION_BASH_FOR ~%audio_path%~ ~.+\\.ogg$~ BEGIN
            OUTER_SPRINT wavfile ~%audio_path%/%BASH_FOR_RES%.wav~
            REGISTER_UNINSTALL ~%wavfile%~
            AT_NOW ~%oggdec_path%/oggdec.exe \"%BASH_FOR_FILESPEC%\" %cli_quiet%~
            MOVE ~%wavfile%~ ~%output_path%~
          END
        END ELSE BEGIN
          WARN ~WARNING: audio was not installed because oggdec.exe could not be found in %oggdec_path%~
        END
      END

      osx
      BEGIN
        ACTION_IF FILE_EXISTS ~%sox_path%/sox~ BEGIN
          ACTION_IF quiet BEGIN
            OUTER_SPRINT cli_quiet \"-q\" // can\'t actually run mac sox to verify
          END ELSE OUTER_SPRINT cli_quiet \"\"
          AT_NOW ~chmod +x \'%sox_path%/sox\'~
          ACTION_BASH_FOR ~%audio_path%~ ~.+\\.ogg$~ BEGIN
            OUTER_SPRINT wavfile ~%audio_path%/%BASH_FOR_RES%.wav~
            REGISTER_UNINSTALL ~%wavfile%~
            AT_NOW ~\'%sox_path%/sox\' %cli_quiet% \'%BASH_FOR_FILESPEC%\' \'%wavfile%\'~
            MOVE ~%wavfile%~ ~%output_path%~
          END
        END ELSE BEGIN
          WARN ~WARNING: audio was not installed because sox could not be found in %sox_path%~
        END
      END

      unix
      BEGIN
        OUTER_SET installed = 1
        ACTION_IF quiet BEGIN
          OUTER_SPRINT cli_quiet \"2>/dev/null\" // because Case_ins breaks -Q
        END ELSE OUTER_SPRINT cli_quiet \"\"
        ACTION_BASH_FOR ~%audio_path%~ ~.+\\.ogg$~ BEGIN
          OUTER_SPRINT wavfile ~%audio_path%/%BASH_FOR_RES%.wav~
          REGISTER_UNINSTALL ~%wavfile%~
          AT_NOW ~oggdec \'%BASH_FOR_FILESPEC%\' %cli_quiet%~
          ACTION_IF FILE_EXISTS ~%wavfile%~ AND !FILE_SIZE ~%wavfile%~ 0 BEGIN
            MOVE ~%wavfile%~ ~%output_path%~
          END ELSE OUTER_SET installed = 0
        END
        ACTION_IF !installed BEGIN
          WARN \"WARNING: audio was not installed because WAV files were not found. Are you sure you have oggdec installed?\"
        END
      END
      DEFAULT
    END
  END ELSE BEGIN
    ACTION_IF !music BEGIN
      OUTER_SPRINT ext \"wav\"
    END ELSE BEGIN
      OUTER_SPRINT ext \"acm\"
    END
    ACTION_BASH_FOR ~%audio_path%~ ~.+\\.ogg$~ BEGIN
      COPY_LARGE ~%BASH_FOR_FILESPEC%~ ~%output_path%/%BASH_FOR_RES%.%ext%~
    END
  END
END
  ");
(".../WEIDU_NAMESPACE/handle_charsets.tpa","DEFINE_ACTION_FUNCTION fl#HANDLE_CHARSETS#WHICH#INFER
  STR_VAR
    language = ~~
  RET
    charset
BEGIN
  ACTION_MATCH \"%language%\" WITH
    \".*schinese.*\" \".*zh_CN.*\"
    BEGIN
      OUTER_SPRINT charset \"CP936\"
    END

    /* Doubts remain about whether CP950 is the correct charset for
     * Traditional Chinese, mainly due to the translation of the
     * BG2 Fixpack, which does not appear to be perfectly represented
     * by CP950.
     * Possible other alternatives include something involving the
     * Hong Kong Supplementary Character Set (HKSCS) or Windows\'
     * non-standard CP950+CP951 hack (which appears to be unavailable
     * outside of Traditionally Chinese Windows).
     * Cf. Wikipedia on Big5.
     */
    \".*tchinese.*\"
    BEGIN
      OUTER_SPRINT charset \"CP950\"
    END

    \".*czech.*\" \".*cs_CZ.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1250\"
    END

    \".*english.*\" \".*american.*\" \".*en_US.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*french.*\" \".*francais.*\" \".*fr_FR.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*german.*\" \".*deutsch.*\" \".*de_DE.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*italian.*\" \".*italiano.*\" \".*it_IT.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*japanese.*\" \".*ja_JP.*\"
    BEGIN
      OUTER_SPRINT charset \"CP932\"
    END

    \".*korean.*\" \".*ko_KR.*\"
    BEGIN
      OUTER_SPRINT charset \"CP949\"
    END

    \".*polish.*\" \".*polski.*\" \".*pl_PL.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1250\"
    END

    \".*russian.*\" \".*ru_RU.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1251\"
    END

    \".*spanish.*\" \".*castilian.*\" \".*espanol.*\" \".*castellano.*\" \".*es_ES.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*brazilian.*\" \".*portuguese?.*\" \".*pt_BR.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*swedish.*\" \".*svenska.*\" \".*sv_SE.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*dutch.*\" \".*nederlands.*\" \".*nl_NL.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*latina?.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*faroese.*\" \".*foeroyskr.*\" \".*fo_FO.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1252\"
    END

    \".*hungarian.*\" \".*hu_HU.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1250\"
    END

    \".*turkish.*\" \".*tr_TR.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1254\"
    END

    \".*ukrainian.*\" \".*uk_UA.*\"
    BEGIN
      OUTER_SPRINT charset \"CP1251\"
    END

    \".*norwegian.*\" \".*bokmål.*\" \".*norsk.*\" \".*no_NB.*\"
    BEGIN
      OUTER_SPRINT chatset \"CP1252\"
    END

    DEFAULT
      FAIL \"ERROR: charset could not be inferred for language %language%\"
  END
END

DEFINE_ACTION_FUNCTION fl#HANDLE_CHARSETS#WHICH
  INT_VAR
    infer_charsets = 0
  STR_VAR
    language = ~~
    charset_table = ~~
  RET
    charset
BEGIN
  ACTION_IF infer_charsets BEGIN
    LAF fl#HANDLE_CHARSETS#WHICH#INFER STR_VAR language RET charset END
  END ELSE BEGIN
    ACTION_TO_LOWER language
    ACTION_IF VARIABLE_IS_SET $EVAL \"%charset_table%\"(\"%language%\") BEGIN
      OUTER_SPRINT charset $EVAL \"%charset_table%\"(\"%language%\")
    END ELSE BEGIN
      FAIL \"ERROR: no tabulated charset could be found for language %language%\"
    END
  END
END

DEFINE_ACTION_FUNCTION fl#HANDLE_CHARSETS#CONVERT
  STR_VAR
    iconv = ~iconv~
    quote = ~\"~
    in_path = ~~
    out_path = ~~
    file = ~~
    from_charset = ~123fakecharset~
    to_charset = ~UTF-8~
BEGIN
  /*
   * iconv will happily be told to use an incorrect -f encoding and
   * produce invalid output, so may as well provide the -c option.
   */
  OUTER_SPRINT c_option \"-c\"
  OUTER_SPRINT infile ~%in_path%/%file%~
  ACTION_IF ~%in_path%~ STR_EQ ~%out_path%~ BEGIN
    OUTER_SPRINT outfile ~%in_path%/fl#utf8_%file%~
  END ELSE OUTER_SPRINT outfile ~%out_path%/%file%~
  ACTION_TRY
    COPY \"%infile%\" \"%outfile%\" // so outfile is uninstalled
    /*
     * The -o option does not appear to be supported by all implementations
     */
    AT_NOW ~%iconv% %c_option% -f %from_charset% -t %to_charset% %quote%%infile%%quote% > %quote%%outfile%%quote%~
    ACTION_IF ~%in_path%~ STR_EQ ~%out_path%~ BEGIN
      OUTER_SPRINT dest ~%infile%~
    END ELSE OUTER_SPRINT dest ~%outfile%~
    COPY \"%outfile%\" \"%dest%\"
      REPLACE_TEXTUALLY
        ~-\\*-[%TAB% ]*\\(en\\)?coding:[%TAB% ]*%from_charset%[%TAB% ]*-\\*-~
        ~-*- coding: %to_charset% -*-~
  WITH
    DEFAULT
      PRINT \"ERROR: unable to convert %infile% from %from_charset% into %to_charset%\"
      ACTION_RERAISE
  END
END

DEFINE_ACTION_FUNCTION fl#HANDLE_CHARSETS#RECURSE
  STR_VAR
    in_path = \"\"
    out_path = \"\"
    file_regexp = \"\"
    function = \"\"
BEGIN
  ACTION_IF verbose BEGIN
    PRINT \"#RECURSE is calling terminal function on %in_path% with out_path: %out_path%\"
  END
  ACTION_BASH_FOR \"%in_path%\" \"%file_regexp%\" BEGIN
    LAF \"%function%\"
      STR_VAR
        file = EVAL \"%BASH_FOR_FILE%\"
        in_path = EVAL \"%BASH_FOR_DIRECTORY%\"
        out_path
    END
  END
  ACTION_CLEAR_ARRAY dir_array
  GET_DIRECTORY_ARRAY dir_array \"%in_path%\" \".+\"
  ACTION_PHP_EACH EVAL dir_array AS _ => in_path BEGIN
    ACTION_IF \"%in_path%\" STRING_MATCHES_REGEXP \".*\\.$\" BEGIN
      LAF RES_OF_FILESPEC
        STR_VAR
          filespec = EVAL \"%in_path%\"
        RET
          directory = res
      END
      OUTER_SET convert = 1
      ACTION_PHP_EACH \"%exclude_directories%\" AS _ => excl_dir BEGIN
        ACTION_IF \"%directory%\" STR_EQ \"%excl_dir%\" BEGIN
          OUTER_SET convert = 0
        END
      END
      ACTION_IF convert AND verbose BEGIN
        PRINT \"#RECURSE is recursing through %in_path% with out_path: %out_path%/%directory%\"
      END
      ACTION_IF convert BEGIN
        LAF fl#HANDLE_CHARSETS#RECURSE
          STR_VAR
            in_path
            out_path = EVAL \"%out_path%/%directory%\"
            file_regexp
            function
        END
      END
    END
  END
END

DEFINE_ACTION_FUNCTION fl#HANDLE_CHARSETS#RECURSE#TERMINAL
  STR_VAR
    file = \"\"
    in_path = \"\"
    out_path = \"\"
BEGIN
  OUTER_SET convert = 1
  /* This makes for a more consistent interface, albeit slightly
   * messier code. noconvert_array is very likely to be short.
   */
  ACTION_PHP_EACH \"%noconvert_array%\" AS _ => noconvert_file BEGIN
    ACTION_IF \"%noconvert_file%\" STRING_MATCHES_REGEXP \".+\\.tra$\" = 0 BEGIN
      OUTER_SPRINT match \"%noconvert_file%\"
    END ELSE OUTER_SPRINT match \"%noconvert_file%.tra\"
    ACTION_IF \"%match%\" STRING_EQUAL_CASE \"%file%\" BEGIN
      OUTER_SET convert = 0
    END
  END
  ACTION_IF convert BEGIN
    ACTION_IF verbose BEGIN
      PRINT \"Converting %in_path%/%file% to %out_path%/%file%\"
    END
    LAF fl#HANDLE_CHARSETS#CONVERT
      STR_VAR
        iconv // from the calling environment (curse the lack of closures)
        quote // from the calling environment
        in_path
        out_path
        file
        from_charset // from the calling environment
        to_charset // from the calling environment
    END
  END
END

DEFINE_ACTION_FUNCTION HANDLE_CHARSETS
  INT_VAR
    infer_charsets = 0
    verbose = 0
    from_utf8 = 0
  STR_VAR
    tra_path = ~~
    out_path = EVAL ~%tra_path%~
    default_language = ~~
    language = EVAL ~%LANGUAGE%~
    iconv_path = EVAL ~%tra_path%/iconv~
    charset_table = ~~
    convert_array = ~~
    noconvert_array = ~~
    reload_array = ~~
    file_regexp = ~.+\\.tra$~
BEGIN
  /* Early versions of BG: EE do not include bgee.lua and
   * PST: EE does not include monkfist.2da
   */
  ACTION_IF ((FILE_EXISTS_IN_GAME bgee.lua OR
            FILE_EXISTS_IN_GAME monkfist.2da) AND
            !from_utf8) OR
            (!FILE_EXISTS_IN_GAME bgee.lua AND
            !FILE_EXISTS_IN_GAME monkfist.2da AND
            from_utf8)
  BEGIN
    ACTION_IF verbose BEGIN
      PRINT \"tra_path: %tra_path%\"
      PRINT \"out_path: %out_path%\"
    END
    /*
     * Initial versions mistakenly called the variable infer_charset.
     * For reasons of backwards-compatibility, we use infer_charset
     * to initialise infer_charsets, if appropriate.
     */
    OUTER_SET infer_charsets = (IS_AN_INT infer_charset AND infer_charset) AND !infer_charsets ? 1 : infer_charsets
    ACTION_MATCH ~%WEIDU_OS%~ WITH
      win32
      BEGIN
        OUTER_SPRINT iconv ~%iconv_path%/iconv.exe~
        OUTER_SPRINT quote ~\"~
      END

      osx unix
      BEGIN
        OUTER_SPRINT iconv ~iconv~
        OUTER_SPRINT quote ~\'~
      END

      DEFAULT
    END
    ACTION_IF (\"%WEIDU_OS%\" STRING_EQUAL_CASE \"win32\" AND FILE_EXISTS \"%iconv%\") OR
              (\"%WEIDU_OS%\" STRING_EQUAL_CASE \"osx\" OR \"%WEIDU_OS%\" STRING_EQUAL_CASE \"unix\")
    BEGIN
      ACTION_IF \"%default_language%\" STR_EQ \"%language%\" BEGIN
        OUTER_SPRINT default_language \"\" // do not process twice
      END
      ACTION_FOR_EACH language IN \"%default_language%\" \"%language%\" BEGIN
        ACTION_IF \"%language%\" STR_CMP \"\" AND !FILE_EXISTS ~%tra_path%/%language%/fl#utf8.mrk~ BEGIN
          LAF fl#HANDLE_CHARSETS#WHICH
            INT_VAR
              infer_charsets
            STR_VAR
              language
              charset_table
            RET
              charset
          END
          ACTION_IF !from_utf8 BEGIN
            OUTER_SPRINT from_charset \"%charset%\"
            OUTER_SPRINT to_charset \"UTF-8\"
          END ELSE BEGIN
            OUTER_SPRINT from_charset \"UTF-8\"
            OUTER_SPRINT to_charset \"%charset%\"
          END
          ACTION_IF verbose BEGIN
            PRINT \"Conversion is from unicode?: %from_utf8%\"
            PRINT \"from_charset identified as %from_charset%\"
            PRINT \"to_charset identifed as %to_charset%\"
          END
          ACTION_IF VARIABLE_IS_SET $EVAL \"%convert_array%\"(0) BEGIN
            ACTION_PHP_EACH \"%convert_array%\" AS _ => filename BEGIN
              ACTION_IF \"%filename%\" STRING_MATCHES_REGEXP \".+\\.tra$\" = 0 BEGIN
                OUTER_SPRINT file \"%filename%\"
              END ELSE OUTER_SPRINT file \"%filename%.tra\"
              ACTION_IF verbose BEGIN
                PRINT \"convert_array: %file%\"
              END
              LAF fl#HANDLE_CHARSETS#CONVERT
                STR_VAR
                  iconv
                  quote
                  in_path = EVAL ~%tra_path%/%language%~
                  out_path = EVAL ~%out_path%/%language%~
                  file
                  from_charset
                  to_charset
              END
            END
          END ELSE BEGIN
            ACTION_IF verbose BEGIN
              PRINT \"Recursing through %tra_path%/%language%\"
            END
            LAF fl#HANDLE_CHARSETS#RECURSE
              STR_VAR
                in_path = EVAL ~%tra_path%/%language%~
                out_path = EVAL ~%out_path%/%language%~
                file_regexp
                function = ~fl#HANDLE_CHARSETS#RECURSE#TERMINAL~
            END
          END
          ACTION_PHP_EACH \"%reload_array%\" AS _ => file BEGIN
            ACTION_IF verbose BEGIN
              PRINT \"reload_array: %file%\"
            END
            ACTION_IF \"%file%\" STRING_MATCHES_REGEXP \".+\\.tra$\" = 0 BEGIN
              LOAD_TRA ~%out_path%/%language%/%file%~
            END ELSE LOAD_TRA ~%out_path%/%language%/%file%.tra~
          END
          ACTION_IF ~%tra_path%~ STR_EQ ~%out_path%~ BEGIN
            COPY_EXISTING bolt01.itm ~%tra_path%/%language%/fl#utf8.mrk~
          END
        END
      END
    END ELSE BEGIN
      FAIL \"ERROR: charsets were not converted because iconv could not be found in %iconv_path%\"
    END
  END
END
  ");
(".../WEIDU_NAMESPACE/handle_tilesets.tpa","DEFINE_ACTION_FUNCTION HANDLE_TILESETS
  STR_VAR
    tiz_path = EVAL \"%MOD_FOLDER%/tiz\"
    tisunpack_path = EVAL \"%tiz_path%\"
    output_path = \"override\"
BEGIN
  ACTION_MATCH \"%WEIDU_OS%\" WITH
    win32
    BEGIN
      OUTER_SPRINT tisunpack \"tisunpack.exe\"
      OUTER_SPRINT quote ~\"~
    END

    osx unix
    BEGIN
      OUTER_SPRINT tisunpack \"tisunpack\"
      ACTION_IF FILE_EXISTS ~%tisunpack_path%/%WEIDU_OS%/%tisunpack%~ BEGIN
        AT_NOW ~chmod +x \'%tisunpack_path%/%WEIDU_OS%/%tisunpack%\'~
      END
      OUTER_SPRINT quote ~\'~
    END
    DEFAULT
  END
  ACTION_IF FILE_EXISTS ~%tisunpack_path%/%WEIDU_OS%/%tisunpack%~ BEGIN
    ACTION_BASH_FOR ~%tiz_path%~ ~.+\\.tiz$~ BEGIN
      OUTER_SPRINT tisfile ~%output_path%/%BASH_FOR_RES%.tis~
      REGISTER_UNINSTALL ~%tisfile%~
      AT_NOW ~%tisunpack_path%/%WEIDU_OS%/%tisunpack% -s -f -o %quote%%tisfile%%quote% %quote%%BASH_FOR_FILESPEC%%quote%~
    END
  END ELSE ACTION_IF \"%WEIDU_OS%\" STRING_EQUAL_CASE \"unix\" BEGIN // Support tisunpack being located on the system path
    OUTER_SET installed = 1
    ACTION_BASH_FOR ~%tiz_path%~ ~.+\\.tiz$~ BEGIN
      OUTER_SPRINT tisfile ~%output_path%/%BASH_FOR_RES%.tis~
      REGISTER_UNINSTALL ~%tisfile%~
      AT_NOW ~tisunpack -s -f -o \'%tisfile%\' \'%BASH_FOR_FILESPEC%\'~
      ACTION_IF !FILE_EXISTS ~%tisfile%~ OR
                FILE_SIZE ~%tisfile%~ 0
      BEGIN
        OUTER_SET installed = 0
      END
    END
    ACTION_IF !installed BEGIN
      FAIL ~ERROR: tilesets were not installed because TIS files were not found. Are you sure you have tisunpack installed?~
    END
  END ELSE BEGIN
    FAIL ~ERROR: tilesets were not installed because %tisunpack% was not found in %tisunpack_path%/%WEIDU_OS%~
  END
END
  ");
(".../WEIDU_NAMESPACE/res_of_spell_ids.tpa","DEFINE_ACTION_FUNCTION ~RES_NAME_OF_SPELL_NUM~
  INT_VAR
    spell_num = 0
  RET
    spell_res
    spell_name
BEGIN
  LAUNCH_ACTION_MACRO ~RES_NAME_OF_SPELL_NUM~
END

DEFINE_ACTION_FUNCTION ~RES_NUM_OF_SPELL_NAME~
  STR_VAR
    spell_name = ~~
  RET
    spell_res
    spell_num
BEGIN
  LAUNCH_ACTION_MACRO ~RES_NUM_OF_SPELL_NAME~
END

DEFINE_ACTION_FUNCTION ~NAME_NUM_OF_SPELL_RES~
  STR_VAR
    spell_res = ~~
  RET
    spell_num
    spell_name
BEGIN
  LAUNCH_ACTION_MACRO ~NAME_NUM_OF_SPELL_RES~
END

DEFINE_PATCH_FUNCTION RES_NAME_OF_SPELL_NUM
  INT_VAR
    spell_num = 0
  RET
    spell_res
    spell_name
BEGIN
  INNER_ACTION BEGIN
    LAF RES_NAME_OF_SPELL_NUM INT_VAR spell_num RET spell_res spell_name END
  END
END

DEFINE_PATCH_FUNCTION RES_NUM_OF_SPELL_NAME
  STR_VAR
    spell_name = ~~
  RET
    spell_res
    spell_num
BEGIN
  INNER_ACTION BEGIN
    LAF RES_NUM_OF_SPELL_NAME STR_VAR spell_name RET spell_res spell_num END
  END
END

DEFINE_PATCH_FUNCTION NAME_NUM_OF_SPELL_RES
  STR_VAR
    spell_res = ~~
  RET
    spell_num
    spell_name
BEGIN
  INNER_ACTION BEGIN
    LAF NAME_NUM_OF_SPELL_RES STR_VAR spell_res RET spell_num spell_name END
  END
END

DEFINE_ACTION_MACRO ~RES_NAME_OF_SPELL_NUM~ BEGIN
  ACTION_IF ( ~%spell_num%~ < 2000 && ~%spell_num%~ >= 1000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPPR\"
  END ELSE ACTION_IF ( ~%spell_num%~ < 3000 && ~%spell_num%~ >= 2000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPWI\"
  END ELSE ACTION_IF ( ~%spell_num%~ < 4000 && ~%spell_num%~ >= 3000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPIN\"
  END ELSE ACTION_IF ( ~%spell_num%~ < 5000 && ~%spell_num%~ >= 4000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPCL\"
  END ELSE BEGIN
    FAIL ~Invalid spell number: %spell_num%~
  END
  OUTER_PATCH ~~ BEGIN
    LOOKUP_IDS_SYMBOL_OF_INT spell_name SPELL spell_num
  END
  OUTER_SET lc_asn = spell_num
  OUTER_WHILE lc_asn >= 1000 BEGIN
    OUTER_SET lc_asn -= 1000
  END
  ACTION_IF lc_asn < 10 THEN BEGIN
    OUTER_SPRINT spell_res \"%lc_ast%00%lc_asn%\"
  END ELSE ACTION_IF lc_asn < 100 THEN BEGIN
    OUTER_SPRINT spell_res \"%lc_ast%0%lc_asn%\"
  END ELSE BEGIN
    OUTER_SPRINT spell_res \"%lc_ast%%lc_asn%\"
  END
END


DEFINE_ACTION_MACRO ~RES_NUM_OF_SPELL_NAME~ BEGIN
  OUTER_SET spell_num = IDS_OF_SYMBOL (SPELL ~%spell_name%~)
  ACTION_IF ( ~%spell_num%~ < 2000 && ~%spell_num%~ >= 1000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPPR\"
  END ELSE ACTION_IF ( ~%spell_num%~ < 3000 && ~%spell_num%~ >= 2000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPWI\"
  END ELSE ACTION_IF ( ~%spell_num%~ < 4000 && ~%spell_num%~ >= 3000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPIN\"
  END ELSE ACTION_IF ( ~%spell_num%~ < 5000 && ~%spell_num%~ >= 4000 ) BEGIN
    OUTER_SPRINT lc_ast \"SPCL\"
  END ELSE BEGIN
    FAIL ~Invalid spell number: %spell_num%~
  END
  OUTER_SET lc_asn = spell_num
  OUTER_WHILE lc_asn >= 1000 BEGIN
    OUTER_SET lc_asn -= 1000
  END
  ACTION_IF lc_asn < 10 THEN BEGIN
    OUTER_SPRINT spell_res \"%lc_ast%00%lc_asn%\"
  END ELSE ACTION_IF lc_asn < 100 THEN BEGIN
    OUTER_SPRINT spell_res \"%lc_ast%0%lc_asn%\"
  END ELSE BEGIN
    OUTER_SPRINT spell_res \"%lc_ast%%lc_asn%\"
  END
END

DEFINE_ACTION_MACRO ~NAME_NUM_OF_SPELL_RES~ BEGIN
  ACTION_IF ~%spell_res%~ STRING_MATCHES_REGEXP ~^SPPR[0-9][0-9][0-9]$~ = 0 THEN BEGIN
    OUTER_SET lc_ast = 1
  END ELSE ACTION_IF ~%spell_res%~ STRING_MATCHES_REGEXP ~^SPWI[0-9][0-9][0-9]$~ = 0 THEN BEGIN
    OUTER_SET lc_ast = 2
  END ELSE ACTION_IF ~%spell_res%~ STRING_MATCHES_REGEXP ~^SPIN[0-9][0-9][0-9]$~ = 0 THEN BEGIN
    OUTER_SET lc_ast = 3
  END ELSE ACTION_IF ~%spell_res%~ STRING_MATCHES_REGEXP ~^SPCL[0-9][0-9][0-9]$~ = 0 THEN BEGIN
    OUTER_SET lc_ast = 4
  END ELSE BEGIN
    FAIL ~Invalid spell resource: %spell_res%~
  END
  OUTER_PATCH ~%spell_res%~ BEGIN
    REPLACE_EVALUATE CASE_INSENSITIVE ~SP..\\([0-9][0-9][0-9]\\)~ BEGIN
      SPRINT spell_num ~%lc_ast%%MATCH1%~
    END ~%MATCH0%~
    LOOKUP_IDS_SYMBOL_OF_INT spell_name SPELL spell_num
  END
END

DEFINE_PATCH_MACRO RES_NAME_OF_SPELL_NUM BEGIN
  INNER_ACTION BEGIN
    LAM RES_NAME_OF_SPELL_NUM
  END
END

DEFINE_PATCH_MACRO RES_NUM_OF_SPELL_NAME BEGIN
  INNER_ACTION BEGIN
    LAM RES_NUM_OF_SPELL_NAME
  END
END

DEFINE_PATCH_MACRO NAME_NUM_OF_SPELL_RES BEGIN
  INNER_ACTION BEGIN
    LAM NAME_NUM_OF_SPELL_RES
  END
END
  ");
(".../WEIDU_NAMESPACE/sc#addwmpare.tpa","// adding new areas to the worldmap
DEFINE_ACTION_FUNCTION sc#addWmpAre //STR_VAR areName  = \"sc#ar00\"   // default area reference
                                    //        strName  = \"Stockholm\" // default area name
                                    //        strDesc  = \"#-1\"       // default area description

                                    //INT_VAR mapIcon  = 26          // default map icon is 26, City Gates
                                    //        xCoord   = 500         // default x coordinate
                                    //        yCoord   = 500         // default y coordinate

                                    INT_VAR
                                      visible = 0
                                      visibleAdjacent = 0
                                      reachable = 0
                                      visited = 0
                                      inclSv = 0
                                    STR_VAR
                                      worldmap = \"worldmap\"
                                      strName = \"\"
                                      strDesc = \"\"
                                    RET
                                      areNum

BEGIN
  OUTER_SET areNum = 0

  COPY_EXISTING ~%worldmap%.wmp~ ~override~

    // read offsets
    READ_LONG 0x30 \"area_num\"
    READ_LONG 0x34 \"area_off\"
    READ_LONG 0x38 \"link_off\"
    READ_LONG 0x3c \"link_num\"

    t-found = 0 //Look for areas already added (Miloch)
    FOR (t-area = 0; t-area < area_num; t-area += 1) BEGIN //Area loop
      READ_ASCII (t-area * 0xf0 + area_off) t-areref //Area reference
      PATCH_IF (~%t-areref%~ STRING_EQUAL_CASE ~%areName%~ = 1) BEGIN
        t-found = 1
      END
    END

    PATCH_IF t-found = 0 BEGIN //If the area doesn\'t exist in the worldmap

      // add the new area; first we update # of areas, and the following link offset
      WRITE_LONG 0x30 ( \"%area_num%\" + 1 )
      WRITE_LONG 0x38 ( \"%link_off%\" + 0xf0 )
      // add area to worldmap
      INSERT_BYTES          ( \"%area_off%\" +        ( 0xf0 * \"%area_num%\" ) ) 0xf0
      WRITE_EVALUATED_ASCII ( \"%area_off%\" +        ( 0xf0 * \"%area_num%\" ) ) \"%areName%\"    // area reference
      WRITE_EVALUATED_ASCII ( \"%area_off%\" + 0x08 + ( 0xf0 * \"%area_num%\" ) ) \"%areName%\"    // area reference
      WRITE_EVALUATED_ASCII ( \"%area_off%\" + 0x10 + ( 0xf0 * \"%area_num%\" ) ) \"%areName%\"    // area reference
      WRITE_LONG            ( \"%area_off%\" + 0x30 + ( 0xf0 * \"%area_num%\" ) )              // flags
                                ( ( visible         ? BIT0 : 0 ) |
                                  ( visibleAdjacent ? BIT1 : 0 ) |
                                  ( reachable       ? BIT2 : 0 ) |
                                  ( visited         ? BIT3 : 0 ) )
      WRITE_LONG            ( \"%area_off%\" + 0x34 + ( 0xf0 * \"%area_num%\" ) ) \"%mapIcon%\"    // map icon
      WRITE_LONG            ( \"%area_off%\" + 0x38 + ( 0xf0 * \"%area_num%\" ) ) \"%xCoord%\"     // x coordinate
      WRITE_LONG            ( \"%area_off%\" + 0x3C + ( 0xf0 * \"%area_num%\" ) ) \"%yCoord%\"     // y coordinate
      PATCH_IF \"%strName%\" STR_CMP \"\" BEGIN
        SAY                 ( \"%area_off%\" + 0x40 + ( 0xf0 * \"%area_num%\" ) ) \"%strName%\"    // area name
      END ELSE SAY          ( \"%area_off%\" + 0x40 + ( 0xf0 * \"%area_num%\" ) ) #-1
      PATCH_IF \"%strDesc%\" STR_CMP \"\" BEGIN
        SAY                 ( \"%area_off%\" + 0x44 + ( 0xf0 * \"%area_num%\" ) ) \"%strDesc%\"    // area description
      END ELSE SAY          ( \"%area_off%\" + 0x44 + ( 0xf0 * \"%area_num%\" ) ) #-1
      // feel free to set flags and such here

      // re-read link offset, as we just changed it
      READ_LONG 0x38 \"link_off\"

      // set up some shorthand
      SET nlink_l = 0x00
      SET wlink_l = 0x08
      SET slink_l = 0x10
      SET elink_l = 0x18

      // set entry variable to 0, so that we know what the number of the current area entry in the worldmap is
      SET entry = 0

      // prove to bigg that this is useful, and hopefully he\'ll think I\'m a little less PITA for requesting it
      GET_OFFSET_ARRAY areas WMP_AREAS
      PHP_EACH areas AS an => loc BEGIN

        // run functions
        LAUNCH_PATCH_FUNCTION ~sc#toNewAre~ END
        LAUNCH_PATCH_FUNCTION ~sc#fromNewAre~ END

        // update entry variable
        SET entry = ( \"%entry%\" + 1 )
      END

      CLEAR_ARRAY areas
      SET areNum = \"%area_num%\"

    END
  BUT_ONLY

  // save games
  ACTION_IF ( \"%inclSv%\" ) BEGIN
    ACTION_IF !IS_SILENT BEGIN 
      PRINT ~Adding wmp area \"%strName%\"~
    END   
    MKDIR \"%SAVE_DIRECTORY%\"
    GET_DIRECTORY_ARRAY save \"%SAVE_DIRECTORY%\" ~~
    LAUNCH_ACTION_FUNCTION ~sc#savepatch~ END
    MKDIR \"%MPSAVE_DIRECTORY%\"
    GET_DIRECTORY_ARRAY save \"%MPSAVE_DIRECTORY%\" ~~
    LAUNCH_ACTION_FUNCTION ~sc#savepatch~ END
  END
END


DEFINE_ACTION_FUNCTION sc#savepatch BEGIN
   ACTION_PHP_EACH save AS from => to BEGIN
      ACTION_IF ( FILE_EXISTS ~%to%/%worldmap%.wmp~ == 1 ) BEGIN
        COPY + ~%to%/%worldmap%.wmp~ ~%to%/%worldmap%.wmp~
          // read offsets
          READ_LONG 0x30 \"area_num\"
          READ_LONG 0x34 \"area_off\"
          READ_LONG 0x38 \"link_off\"
          READ_LONG 0x3c \"link_num\"

          t-found = 0 //Look for areas already added (Miloch)
          FOR (t-area = 0; t-area < area_num; t-area += 1) BEGIN //Area loop
            READ_ASCII (t-area * 0xf0 + area_off) t-areref //Area reference
            PATCH_IF (~%t-areref%~ STRING_EQUAL_CASE ~%areName%~ = 1) BEGIN
              t-found = 1
            END
          END

          PATCH_IF t-found = 0 BEGIN //If the area doesn\'t exist in the worldmap
            // add the new area; first we update # of areas, and the following link offset
            WRITE_LONG 0x30 ( \"%area_num%\" + 1 )
            WRITE_LONG 0x38 ( \"%link_off%\" + 0xf0 )

            // add area to worldmap
            INSERT_BYTES          ( \"%area_off%\" +        ( 0xf0 * \"%area_num%\" ) ) 0xf0
            WRITE_EVALUATED_ASCII ( \"%area_off%\" +        ( 0xf0 * \"%area_num%\" ) ) \"%areName%\"  // area reference
            WRITE_EVALUATED_ASCII ( \"%area_off%\" + 0x08 + ( 0xf0 * \"%area_num%\" ) ) \"%areName%\"  // area reference
            WRITE_EVALUATED_ASCII ( \"%area_off%\" + 0x10 + ( 0xf0 * \"%area_num%\" ) ) \"%areName%\"  // area reference
            WRITE_LONG            ( \"%area_off%\" + 0x30 + ( 0xf0 * \"%area_num%\" ) )              // flags
                                    ( ( visible         ? BIT0 : 0 ) |
                                      ( visibleAdjacent ? BIT1 : 0 ) |
                                      ( reachable       ? BIT2 : 0 ) |
                                      ( visited         ? BIT3 : 0 ) )
            WRITE_LONG            ( \"%area_off%\" + 0x34 + ( 0xf0 * \"%area_num%\" ) ) \"%mapIcon%\"  // map icon
            WRITE_LONG            ( \"%area_off%\" + 0x38 + ( 0xf0 * \"%area_num%\" ) ) \"%xCoord%\"   // x coordinate
            WRITE_LONG            ( \"%area_off%\" + 0x3C + ( 0xf0 * \"%area_num%\" ) ) \"%yCoord%\"   // y coordinate
            SAY                   ( \"%area_off%\" + 0x40 + ( 0xf0 * \"%area_num%\" ) ) \"%strName%\"  // area name
            SAY                   ( \"%area_off%\" + 0x44 + ( 0xf0 * \"%area_num%\" ) ) \"%strDesc%\"  // area description
            // feel free to set flags and such here

            // re-read link offset, as we just changed it
            READ_LONG 0x38 \"link_off\"

            // set up some shorthand
            SET nlink_l = 0x00
            SET wlink_l = 0x08
            SET slink_l = 0x10
            SET elink_l = 0x18

            // set entry variable to 0, so that we know what the number of the current area entry in the worldmap is
            SET entry = 0

            // Prove to bigg that this is useful, and hopefully he\'ll think I\'m a little less PITA for requesting it
            GET_OFFSET_ARRAY areas WMP_AREAS
            PHP_EACH areas AS an => loc BEGIN

              // run functions
              LAUNCH_PATCH_FUNCTION ~sc#toNewAre~ END
              LAUNCH_PATCH_FUNCTION ~sc#fromNewAre~ END

              // update entry variable
              SET entry = ( \"%entry%\" + 1 )
            END

            CLEAR_ARRAY areas
          END
        BUT_ONLY
      END
    END
  END


DEFINE_PATCH_FUNCTION sc#toNewAre BEGIN
  // read area name
  READ_ASCII ( \"%loc%\" ) \"area\"

  PHP_EACH toNewArea AS are => ent BEGIN
    PATCH_IF ( ( \"%are_0%\" STRING_EQUAL_CASE \"%area%\" = 1 ) ) BEGIN
      // read link directions
      READ_SHORT ( \"%loc%\" + 0x50 )              \"nlink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x4 )        \"#nlink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x08 )       \"wlink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x08 + 0x4 ) \"#wlink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x10 )       \"slink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x10 + 0x4 ) \"#slink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x18 )       \"elink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x18 + 0x4 ) \"#elink\"

      DEFINE_ARRAY links BEGIN nlink elink slink wlink END

      // tb# count the number of elements in the array, populate helper arrays
      SET tb#sort_cnt = 0
      PHP_EACH links AS tb#sort_from => tb#sort_to BEGIN
        SPRINT $tb#sort_index(~%tb#sort_cnt%~) ~%tb#sort_from_0%~
        SPRINT $tb#sort_value(~%tb#sort_cnt%~) ~%tb#sort_to%~
        SET tb#sort_cnt += 1
      END
      CLEAR_ARRAY links

      // tb# define the swapping condition & what to swap
      INNER_ACTION BEGIN
        DEFINE_PATCH_MACRO ~tb#sort_swap~ BEGIN
          SET tb#sort_val_i = EVALUATE_BUFFER $tb#sort_value(~%tb#sort_i%~)
          SET tb#sort_val_j = EVALUATE_BUFFER $tb#sort_value(~%tb#sort_j%~)
          SPRINT tb#sort2_val_i $tb#sort_value(~%tb#sort_i%~)
          SPRINT tb#sort2_val_j $tb#sort_value(~%tb#sort_j%~)
          SET tb#sort2_val_i = EVALUATE_BUFFER ~#%tb#sort2_val_i%~
          SET tb#sort2_val_j = EVALUATE_BUFFER ~#%tb#sort2_val_j%~
          PATCH_IF (tb#sort_val_i < tb#sort_val_j || (tb#sort_val_i = tb#sort_val_j && tb#sort2_val_j > tb#sort2_val_i)) BEGIN
            SPRINT tb#sort_tmp $tb#sort_value(~%tb#sort_i%~)
            SPRINT $tb#sort_value(~%tb#sort_i%~) $tb#sort_value(~%tb#sort_j%~)
            SPRINT $tb#sort_value(~%tb#sort_j%~) ~%tb#sort_tmp%~
          END
        END
      END

      // tb# sort the array. Move from Bubble sort to Quick Sort if you want
      FOR (tb#sort_i = 0; tb#sort_i < tb#sort_cnt; tb#sort_i+=1) BEGIN
        FOR (tb#sort_j = 0; tb#sort_j < tb#sort_cnt; tb#sort_j +=1) BEGIN
          LAUNCH_PATCH_MACRO ~tb#sort_swap~
        END
      END

      // tb# merge the helping arrays into the main one
      FOR (tb#sort_i = 0; tb#sort_i < tb#sort_cnt; tb#sort_i +=1) BEGIN
        SPRINT $links($tb#sort_index(~%tb#sort_i%~)) $tb#sort_value(~%tb#sort_i%~)
      END

      // tb# clean up
      CLEAR_ARRAY tb#sort_index
      CLEAR_ARRAY tb#sort_value

      // write new # of links
      WRITE_SHORT ( \"%loc%\" + 0x50 + 0x4 ) ( \"%#nlink%\" + 1 )
      WRITE_SHORT ( \"%loc%\" + 0x50 + 0x08 + 0x4 ) ( \"%#wlink%\" + 1 )
      WRITE_SHORT ( \"%loc%\" + 0x50 + 0x10 + 0x4 ) ( \"%#slink%\" + 1 )
      WRITE_SHORT ( \"%loc%\" + 0x50 + 0x18 + 0x4 ) ( \"%#elink%\" + 1 )

      // and also the total number to the worldmap
      READ_LONG  0x3c \"link_num\"
      WRITE_LONG 0x3c ( \"%link_num%\" + 4 )

      // go through each link direction, update index and insert new
      PHP_EACH links AS n => link BEGIN

        // update link index
        SPRINT off ~%link%_l~
        SPRINT off EVALUATE_BUFFER ~%%off%%~
        SPRINT plink EVALUATE_BUFFER ~%%link%%~
        WRITE_SHORT ( \"%loc%\" + 0x50 + \"%off%\" ) ( \"%plink%\" + \"%n_0%\" )

        // insert new link
        INSERT_BYTES          ( \"%link_off%\" + ( 0xd8 * ( \"%plink%\" + \"%n_0%\" ) ) ) 0xd8
        WRITE_LONG            ( \"%link_off%\" + ( 0xd8 * ( \"%plink%\" + \"%n_0%\" ) ) ) \"%area_num%\" // add the last entry
        WRITE_EVALUATED_ASCII ( \"%link_off%\" + ( 0xd8 * ( \"%plink%\" + \"%n_0%\" ) ) + 0x04 ) ~%ent%~    // entrance
        WRITE_LONG            ( \"%link_off%\" + ( 0xd8 * ( \"%plink%\" + \"%n_0%\" ) ) + 0x24 ) ~%tTime%~  // travel time
        WRITE_LONG            ( \"%link_off%\" + ( 0xd8 * ( \"%plink%\" + \"%n_0%\" ) ) + 0x28 ) 0x01       // unknown
      END

      // re-read to check the new offsets
      READ_SHORT ( \"%loc%\" + 0x50 )        \"nlink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x08 ) \"wlink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x10 ) \"slink\"
      READ_SHORT ( \"%loc%\" + 0x50 + 0x18 ) \"elink\"

      // check which one of them is the largest
      PATCH_IF ( ( \"%nlink%\" > \"%wlink%\" ) AND ( \"%nlink%\" > \"%slink%\" ) AND ( \"%nlink%\" > \"%elink%\" ) ) BEGIN
        SET \"llink\" = \"%nlink%\"
      END

      PATCH_IF ( ( \"%wlink%\" > \"%nlink%\" ) AND ( \"%wlink%\" > \"%slink%\" ) AND ( \"%wlink%\" > \"%elink%\" ) ) BEGIN
        SET \"llink\" = \"%wlink%\"
      END

      PATCH_IF ( ( \"%slink%\" > \"%wlink%\" ) AND ( \"%slink%\" > \"%nlink%\" ) AND ( \"%slink%\" > \"%elink%\" ) ) BEGIN
        SET \"llink\" = \"%slink%\"
      END

      PATCH_IF ( ( \"%elink%\" > \"%wlink%\" ) AND ( \"%elink%\" > \"%slink%\" ) AND ( \"%elink%\" > \"%nlink%\" ) ) BEGIN
        SET \"llink\" = \"%elink%\"
      END

      // correct all following links
      PHP_EACH areas AS n2 => loc2 BEGIN
        READ_ASCII (\"%loc2%\") \"area2\"
        // ...as long as it isn\'t the one we\'re adding links to
        PATCH_IF NOT ( \"%area2%\" STRING_EQUAL_CASE \"%are_0%\" = 1 ) BEGIN
          READ_SHORT ( \"%loc2%\" + 0x50 )        \"nlink2\"
          READ_SHORT ( \"%loc2%\" + 0x50 + 0x08 ) \"wlink2\"
          READ_SHORT ( \"%loc2%\" + 0x50 + 0x10 ) \"slink2\"
          READ_SHORT ( \"%loc2%\" + 0x50 + 0x18 ) \"elink2\"

          PATCH_IF ( ( \"%nlink2%\" + 0x04 ) >= \"%llink%\" ) BEGIN
            WRITE_SHORT ( \"%loc2%\" + 0x50 ) ( \"%nlink2%\" + 0x04 )
          END

          PATCH_IF ( ( \"%wlink2%\" + 0x04 ) >= \"%llink%\" ) BEGIN
            WRITE_SHORT ( \"%loc2%\" + 0x50 + 0x08 ) ( \"%wlink2%\" + 0x04 )
          END

          PATCH_IF ( ( \"%slink2%\" + 0x04 ) >= \"%llink%\" ) BEGIN
            WRITE_SHORT ( \"%loc2%\" + 0x50 + 0x10 ) ( \"%slink2%\" + 0x04 )
          END

          PATCH_IF ((\"%elink2%\" + 0x04) >= \"%llink%\") BEGIN
            WRITE_SHORT ( \"%loc2%\" + 0x50 + 0x18 ) ( \"%elink2%\" + 0x04 )
          END
        END
      END
    END
  END
END


DEFINE_PATCH_FUNCTION sc#fromNewAre BEGIN
  // read area name
  READ_ASCII (\"%loc%\") \"area\"

  PHP_EACH fromNewArea AS are => ent BEGIN
    PATCH_IF ((\"%are_0%\" STRING_EQUAL_CASE \"%area%\" = 1)) BEGIN
      // read links in new area
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 )              \"nlink\"
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x4 )        \"#nlink\"
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x08 )       \"wlink\"
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x08 + 0x4 ) \"#wlink\"
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x10 )       \"slink\"
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x10 + 0x4 ) \"#slink\"
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x18 )       \"elink\"
      READ_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x18 + 0x4 ) \"#elink\"

      // write new # of links
      WRITE_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x4 )        ( \"%#nlink%\" + 1 )
      WRITE_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x08 + 0x4 ) ( \"%#wlink%\" + 1 )
      WRITE_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x10 + 0x4 ) ( \"%#slink%\" + 1 )
      WRITE_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + 0x18 + 0x4 ) ( \"%#elink%\" + 1 )

      // write new # to wmp
      READ_LONG  0x3c \"link_num\"
      WRITE_LONG 0x3c ( \"%link_num%\" + 4 )

      // decide order of links
      DEFINE_ARRAY links BEGIN nlink elink slink wlink END

      // go through and add
      PHP_EACH links AS n => link BEGIN
        SPRINT off ~%link%_l~
        SPRINT off EVALUATE_BUFFER ~%%off%%~
        SPRINT plink EVALUATE_BUFFER ~%%link%%~

        // checking whether link is set; if not, put it at the end of file
        SET \"res\" = \"%plink%\" == 0 ? ( \"%link_off%\" + ( 0xd8 * ( \"%link_num%\" + \"%n_0%\" ) ) ) : ( \"%link_off%\" + ( 0xd8 * ( \"%plink%\" + \"%n_0%\" ) ) )
        SET \"lin\" = \"%plink%\" == 0 ? ( \"%link_num%\" + \"%n_0%\" ) : ( \"%plink%\" + \"%n_0%\" )

        // update link index
        WRITE_SHORT ( ( \"%area_off%\" + ( 0xf0 * \"%area_num%\" ) ) + 0x50 + off ) \"%lin%\"

        // insert new link
        INSERT_BYTES ( \"%res%\" ) 0xd8
        WRITE_LONG ( \"%res%\" ) \"%entry%\"                 // area reference
        WRITE_EVALUATED_ASCII ( \"%res%\" + 0x04 ) ~%ent%~ // entrance
        WRITE_LONG ( \"%res%\" + 0x24 ) ~%tTime%~          // travel time
        WRITE_LONG ( \"%res%\" + 0x28 ) 0x01               // unknown
      END
    END
  END
END
  ");
(".../WEIDU_NAMESPACE/star_of_filespec.tpa","DEFINE_ACTION_FUNCTION DIRECTORY_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    directory
BEGIN
  OUTER_INNER_PATCH_SAVE filespec \"%filespec%\" BEGIN
    REPLACE_TEXTUALLY EXACT_MATCH \"\\\" \"/\"
  END
  OUTER_SET length = STRING_LENGTH \"%filespec%\"
  OUTER_SET slash = RINDEX (\"/\" \"%filespec%\")
  ACTION_IF length > 0 AND slash > 0 BEGIN
    LAF SUBSTRING
      INT_VAR
        start = 0
        length = slash
      STR_VAR
        string = EVAL \"%filespec%\"
      RET
        directory = substring
    END
  END ELSE ACTION_IF length = 0 BEGIN
    WARN ~WARNING: DIRECTORY_OF_FILESPEC got a filespec of 0 length~
    OUTER_SPRINT directory \"\"
  END ELSE ACTION_IF NOT (slash > 0) BEGIN
    OUTER_SPRINT directory \"\"
  END
END

DEFINE_ACTION_FUNCTION FILE_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    file
BEGIN
  OUTER_INNER_PATCH_SAVE filespec \"%filespec%\" BEGIN
    REPLACE_TEXTUALLY EXACT_MATCH \"\\\" \"/\"
  END
  OUTER_SET length = STRING_LENGTH \"%filespec%\"
  OUTER_SET slash = RINDEX (\"/\" \"%filespec%\")
  ACTION_IF length > 0 BEGIN
    ACTION_IF slash >= 0 BEGIN
      LAF SUBSTRING
        INT_VAR
          start = slash + 1
          length = length - slash - 1
        STR_VAR
          string = EVAL \"%filespec%\"
        RET
          file = substring
      END
    END ELSE ACTION_IF slash < 0 BEGIN
      OUTER_SPRINT file \"%filespec%\"
    END
  END ELSE BEGIN
    WARN ~WARNING: FILE_OF_FILESPEC got a filespec of 0 length~
    OUTER_SPRINT file \"\"
  END
END

DEFINE_ACTION_FUNCTION RES_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    res
BEGIN
  OUTER_INNER_PATCH_SAVE filespec \"%filespec%\" BEGIN
    REPLACE_TEXTUALLY EXACT_MATCH \"\\\" \"/\"
  END
  OUTER_SET length = STRING_LENGTH \"%filespec%\"
  OUTER_SET slash = RINDEX (\"/\" \"%filespec%\")
  OUTER_SET dot = RINDEX (\"\\.\" \"%filespec%\")
  ACTION_IF length > 0 AND (slash + 1) < length BEGIN
    ACTION_IF dot < 0 OR dot < slash BEGIN // extensionless file
      LAF SUBSTRING
        INT_VAR
          start = slash + 1
          length = length - slash - 1
        STR_VAR
          string = EVAL \"%filespec%\"
        RET
          res = substring
      END
    END ELSE ACTION_IF dot = 0 OR (slash + 1) = dot BEGIN // dotfile
      LAF SUBSTRING
        INT_VAR
          start = slash + 1
          length = length - slash - 1
        STR_VAR
          string = EVAL \"%filespec%\"
        RET
          res = substring
      END
    END ELSE ACTION_IF dot > 0 AND dot > slash BEGIN // regular file
      LAF SUBSTRING
        INT_VAR
          start = slash + 1
          length = dot - slash - 1
        STR_VAR
          string = EVAL \"%filespec%\"
        RET
          res = substring
      END
    END
  END ELSE ACTION_IF length = 0 BEGIN
    WARN ~WARNING: RES_OF_FILESPEC got a filespec of 0 length~
    OUTER_SPRINT res \"\"
  END ELSE ACTION_IF (slash + 1) = length BEGIN
    OUTER_SPRINT res \"\"
  END
END

DEFINE_ACTION_FUNCTION EXT_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    ext
BEGIN
  OUTER_SET length = STRING_LENGTH \"%filespec%\"
  OUTER_SET slash = RINDEX (\"/\" \"%filespec%\")
  OUTER_SET dot = RINDEX (\"\\.\" \"%filespec%\")
  ACTION_IF length > 0 AND (slash + 1) < length BEGIN
    ACTION_IF dot < 0 BEGIN // extensionless file
      OUTER_SPRINT ext \"\"
    END ELSE ACTION_IF dot = 0 OR (slash + 1) = dot BEGIN // dotfile
      OUTER_SPRINT ext \"\"
    END ELSE ACTION_IF dot > 0 AND dot > slash BEGIN // regular file
      LAF SUBSTRING
        INT_VAR
          start = dot + 1
          length = length - dot - 1
        STR_VAR
          string = EVAL \"%filespec%\"
        RET
          ext = substring
      END
    END
  END ELSE ACTION_IF length = 0 BEGIN
    WARN ~WARNING: EXT_OF_FILESPEC got a filespec of 0 length~
    OUTER_SPRINT ext \"\"
  END ELSE ACTION_IF (slash + 1) = length BEGIN
    OUTER_SPRINT ext \"\"
  END
END

DEFINE_PATCH_FUNCTION DIRECTORY_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    directory
BEGIN
  INNER_ACTION BEGIN
    LAF DIRECTORY_OF_FILESPEC
      STR_VAR
        filespec
      RET
        directory
    END
  END
END

DEFINE_PATCH_FUNCTION FILE_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    file
BEGIN
  INNER_ACTION BEGIN
    LAF FILE_OF_FILESPEC
      STR_VAR
        filespec
      RET
        file
    END
  END
END

DEFINE_PATCH_FUNCTION RES_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    res
BEGIN
  INNER_ACTION BEGIN
    LAF RES_OF_FILESPEC
      STR_VAR
        filespec
      RET
        res
    END
  END
END

DEFINE_PATCH_FUNCTION EXT_OF_FILESPEC
  STR_VAR
    filespec = \"\"
  RET
    ext
BEGIN
  INNER_ACTION BEGIN
    LAF EXT_OF_FILESPEC
      STR_VAR
        filespec
      RET
        ext
    END
  END
END
  ");
(".../WEIDU_NAMESPACE/store_functions.tpa","/*
Author: Argent77

v1: Initial release.
*/


/**
 * Adds an item to the current STO file. This is a PATCH function.
 * SET charge1          Number charges of the 1st ability or quantity for stackables. (Default: 0)
 * SET charge2          Number charges of the 2nd ability. (Default: 0)
 * SET charge3          Number charges of the 3rd ability. (Default: 0)
 * SET stack            Number of item instances the store carries in the stack. (Default: 1)
 * SET unlimited        Set to non-zero if the store should carry an inexhaustible stack of the new item. (Default: 0)
 * SET overwrite        Set to non-zero to overwrite any instances of an existing sale entry of matching item resref 
 *                      when found. (Default: 0)
 * SET expiration       The item\'s expiration time, when it will be replaced with the drained item. (Default: 0)
 * SPRINT item_name     The resource name (resref) of the item to add.
 * SPRINT position      Desired position of the item in the list of sale entries. The following syntax is supported:
 *                      AFTER resref    Will place the new item directly behind the item given by \"resref\".
 *                                      You can list more than one resref, separated by space. The new item will be 
 *                                      added after the entry of the first matching resref.
 *                      BEFORE resref   Will place the new item directly before the item given by \"resref\".
 *                                      You can list more than one resref, separated by space. The new item will be 
 *                                      added before the entry of the first matching resref.
 *                      LAST            Will place the new item after all existing items.
 *                      FIRST           Will place the new item before all existing items.
 *                      AT value        Will place the new item at the position given by the number \"value\".
 *                                      Use negative values to place the new item relative to the last item position 
 *                                      in reverse order.
 *                      (Default: FIRST)
 * SPRINT flags         Use numeric values or the following constants: none, identified, unstealable, stolen.
 *                      Constants can be combined by using ampersand (&) or space as separators 
 *                      (e.g. identified&unstealable). (Default: none)
 * SPRINT sale_trigger  Availability trigger (STO V1.1 only). The following syntax is supported:
 *                      Trigger string          Example: GlobalGT(\"MyCondition\",\"GLOBAL\",0)
 *                      Strref value            Example: #1234
 *                      Translation reference   Example: @1000
 *                      (Default: #-1)
 * RETURN index         Index of the added item or the last matching index when overwriting items.
 *                      Returns -1 if the item could not be added or updated.
 * RETURN offset        Offset of the added item or the last matching offset when overwriting items.
 *                      Returns -1 if the item could not be added or updated.
 */
DEFINE_PATCH_FUNCTION ~ADD_STORE_ITEM_EX~
INT_VAR
  charge1       = 0
  charge2       = 0
  charge3       = 0
  stack         = 1
  expiration    = 0
  unlimited     = 0
  overwrite     = 0
STR_VAR
  item_name     = ~~
  position      = ~FIRST~
  flags         = ~none~
  sale_trigger  = ~#-1~
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~ADD_STORE_ITEM_EX~
  RET
    failed
    version
    HEADER_SIZE = header_size
    SALE_SIZE = sale_size
    DRINK_SIZE = drink_size
  END

  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x34 ofs_sales
    READ_LONG 0x38 num_sales

    PATCH_IF (num_sales = 0 && ofs_sales < HEADER_SIZE) BEGIN
      // Default order of sections: Drinks < Sales < Cures < Purchases
      READ_LONG 0x4c ofs  // drinks
      PATCH_IF (ofs >= HEADER_SIZE) BEGIN
        READ_LONG 0x50 num
        SET size = DRINK_SIZE
      END

      PATCH_IF (ofs >= HEADER_SIZE) BEGIN
        SET ofs_sales = ofs + num * size
      END ELSE BEGIN
        SET ofs_sales = HEADER_SIZE
      END
      WRITE_LONG 0x34 ofs_sales
    END

    // Preparing arguments
    PATCH_IF (NOT ~%item_name%~ STR_EQ ~~) BEGIN
      TO_UPPER ~item_name~
    END ELSE BEGIN
      PATCH_WARN ~ADD_STORE_ITEM_EX: item_name is empty.~
    END

    LPF ~__A7_EVAL_ITEM_FLAGS~
    STR_VAR
      flags
      warn_prefix = ~ADD_STORE_ITEM_EX~
    RET
      item_flags = value
    END

    PATCH_IF (version = 11 && NOT ~%sale_trigger%~ STR_EQ ~~) BEGIN
      LPF ~__A7_RESOLVE_STRREF~
      STR_VAR string = EVAL ~%sale_trigger%~
      RET item_trigger = strref
      END

      // Performing syntax check
      GET_STRREF item_trigger trigger_string
      PATCH_IF (NOT VALID_SCRIPT_TRIGGERS ~%trigger_string%~) BEGIN
        SET item_trigger = \"-1\"
        PATCH_WARN ~ADD_STORE_ITEM_EX: sale_trigger contains invalid code - defaulting to empty trigger.~
      END
    END ELSE BEGIN
      SET item_trigger = \"-1\"
    END

    SET unlimited = unlimited ? 1 : 0

    PATCH_IF (overwrite) BEGIN
      // Updating existing entries of matching item resref
      FOR (idx = 0; idx < num_sales; ++idx) BEGIN
        SET ofs = ofs_sales + idx * SALE_SIZE
        READ_ASCII ofs resref (8) NULL
        PATCH_IF (~%resref%~ STR_EQ ~%item_name%~) BEGIN
          WRITE_SHORT (ofs + 0x08) expiration
          WRITE_SHORT (ofs + 0x0a) charge1
          WRITE_SHORT (ofs + 0x0c) charge2
          WRITE_SHORT (ofs + 0x0e) charge3
          WRITE_LONG (ofs + 0x10) item_flags
          WRITE_LONG (ofs + 0x14) stack
          WRITE_LONG (ofs + 0x18) unlimited
          PATCH_IF (version = 11) BEGIN
            WRITE_LONG (ofs + 0x1c) item_trigger
          END
          SET index = idx
          SET offset = ofs
        END
      END
    END

    PATCH_IF (index < 0) BEGIN
      SET found = 0
      FOR (idx = 0; idx < num_sales; ++idx) BEGIN
        READ_ASCII (ofs_sales + idx * SALE_SIZE) resref (8) NULL
        PATCH_IF (~%resref%~ STR_EQ ~%item_name%~) BEGIN
          SET found = 1
          SET idx = num_sales
        END
      END

      PATCH_IF (NOT found) BEGIN
        // Adding new sale entry
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~Patching %item_name%.ITM into store...~
        END   
        LPF ~__A7_EVAL_POSITION~
        INT_VAR
          num_entries = num_sales
          ofs_entries = ofs_sales
          size_entry  = SALE_SIZE
          ofs_resref  = 0
        STR_VAR
          position
          position_default  = ~FIRST~
          warn_prefix       = ~ADD_STORE_ITEM_EX~
        RET
          item_position = entry_position
        END

        PATCH_IF (item_position >= 0) BEGIN
          SET ofs = ofs_sales + item_position * SALE_SIZE
          INSERT_BYTES ofs SALE_SIZE
          WRITE_ASCIIE ofs ~%item_name%~ (8)
          WRITE_SHORT (ofs + 0x08) expiration
          WRITE_SHORT (ofs + 0x0a) charge1
          WRITE_SHORT (ofs + 0x0c) charge2
          WRITE_SHORT (ofs + 0x0e) charge3
          WRITE_LONG (ofs + 0x10) item_flags
          WRITE_LONG (ofs + 0x14) stack
          WRITE_LONG (ofs + 0x18) unlimited
          PATCH_IF (version = 11) BEGIN
            WRITE_LONG (ofs + 0x1c) item_trigger
          END
          SET index = item_position
          SET offset = ofs

          // Updating item sale count and remaining offsets
          WRITE_LONG 0x38 (num_sales + 1)
          LPF ~__A7_UPDATE_OFFSETS~
          INT_VAR
            value = SALE_SIZE
            skip_offset = 0x34
          END
        END ELSE BEGIN
          PATCH_WARN ~ADD_STORE_ITEM_EX: Could not determine item position.  Skipping...~
        END
      END ELSE BEGIN
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~%item_name%.ITM is already in the store.  Skipping...~
        END  
      END
    END
  END
END


/**
 * Adds a drink to the current STO file. This is a PATCH function.
 * SET price            Price of the drink.
 * SET rate             Rate (%) of displaying a rumor.
 * SET overwrite        Set to non-zero to overwrite any instances of an existing drink of matching drink_name
 *                      when found. (Default: 0)
 * SPRINT drink_name    Name of the drink. The following syntax is supported:
 *                      Literal string          Example: Elminster\'s Choice Beer
 *                      Strref value            Example: #1234
 *                      Translation reference   Example: @1000
 * SPRINT position      Desired position in the list of drinks. The following syntax is supported:
 *                      AFTER name      Will place the new drink directly behind the drink given by \"name\". Name can 
 *                                      either be a strref value (e.g. #1234) or a translation reference (e.g. @1000).
 *                                      You can list more than one name, separated by space. The new drink will be 
 *                                      added after the entry of the first matching name.
 *                      BEFORE name     Will place the new drink directly before the drink given by \"name\". Name can 
 *                                      either be a strref value (e.g. #1234) or a translation reference (e.g. @1000).
 *                                      You can list more than one name, separated by space. The new drink will be 
 *                                      added before the entry of the first matching name.
 *                      LAST            Will place the new drink after all existing drinks.
 *                      FIRST           Will place the new drink before all existing drinks.
 *                      AT value        Will place the new drink at the position given by the number \"value\".
 *                                      Use negative values to place the new drink relative to the last drink position 
 *                                      in reverse order.
 *                      (Default: FIRST)
 * RETURN index         Index of the added drink or the last matching index when overwriting drinks.
 *                      Returns -1 if the drink could not be added or updated.
 * RETURN offset        Offset of the added drink or the last matching offset when overwriting drinks.
 *                      Returns -1 if the drink could not be added or updated.
 */
DEFINE_PATCH_FUNCTION ~ADD_STORE_DRINK~
INT_VAR
  price       = 0
  rate        = 0
  overwrite   = 0
STR_VAR
  drink_name  = ~~
  position    = ~FIRST~
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~ADD_STORE_DRINK~
  RET
    failed
    HEADER_SIZE = header_size
    DRINK_SIZE = drink_size
  END

  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x4c ofs_drinks
    READ_LONG 0x50 num_drinks
    PATCH_IF (num_drinks = 0 && ofs_drinks < HEADER_SIZE) BEGIN
      SET ofs_drinks = HEADER_SIZE
      WRITE_LONG 0x4c ofs_drinks
    END

    // Preparing arguments
    PATCH_IF (~%drink_name%~ STR_EQ ~~) BEGIN
      PATCH_WARN ~ADD_STORE_DRINK: drink_name is empty.~
    END
    LPF ~__A7_RESOLVE_STRREF~
    STR_VAR string = EVAL ~%drink_name%~
    RET drink_strref = strref
    END

    PATCH_IF (overwrite) BEGIN
      // Updating existing entries of matching drink strrefs
      FOR (idx = 0; idx < num_drinks; ++idx) BEGIN
        SET ofs = ofs_drinks + idx * DRINK_SIZE
        READ_LONG (ofs + 0x08) strref
        PATCH_IF (drink_strref = strref) BEGIN
          WRITE_LONG (ofs + 0x0c) price
          WRITE_LONG (ofs + 0x10) rate
          SET index = idx
          SET offset = ofs
        END
      END
    END

    PATCH_IF (index < 0) BEGIN
      SET found = 0
      FOR (idx = 0; idx < num_drinks; ++idx) BEGIN
        READ_LONG (ofs_drinks + idx * DRINK_SIZE + 0x08) strref
        PATCH_IF (drink_strref = strref) BEGIN
          SET found = 1
          SET idx = num_drinks
        END
      END

      PATCH_IF (NOT found) BEGIN
        // Adding new drink entry
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~Patching drink into store...~
        END  
        LPF ~__A7_EVAL_POSITION~
        INT_VAR
          num_entries = num_drinks
          ofs_entries = ofs_drinks
          size_entry  = DRINK_SIZE
          ofs_strref  = 0x08
        STR_VAR
          position
          position_default  = ~FIRST~
          warn_prefix       = ~ADD_STORE_DRINK~
        RET
          drink_position = entry_position
        END

        PATCH_IF (drink_position >= 0) BEGIN
          SET ofs = ofs_drinks + drink_position * DRINK_SIZE
          INSERT_BYTES ofs DRINK_SIZE
          WRITE_LONG (ofs + 0x08) drink_strref
          WRITE_LONG (ofs + 0x0c) price
          WRITE_LONG (ofs + 0x10) rate
          SET index = drink_position
          SET offset = ofs

          // Updating drink count and remaining offsets
          WRITE_LONG 0x50 (num_drinks + 1)
          LPF ~__A7_UPDATE_OFFSETS~
          INT_VAR
            value = DRINK_SIZE
            skip_offset = 0x4c
          END
        END ELSE BEGIN
          PATCH_WARN ~ADD_STORE_DRINK: Could not determine drink position.  Skipping...~
        END
      END ELSE BEGIN
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~Drink of same name is already in the store.  Skipping...~
        END  
      END
    END
  END
END


/**
 * Adds a cure to the current STO file. This is a PATCH function.
 * SET price            The spell price.
 * SET overwrite        Set to non-zero to overwrite any instances of an existing cure entry of matching spell resref 
 *                      when found. (Default: 0)
 * SPRINT spell_name    The resource name (resref) of the spell to add.
 * SPRINT position      Desired position in the list of cures. The following syntax is supported:
 *                      AFTER resref    Will place the new spell directly behind the spell given by \"resref\".
 *                                      You can list more than one resref, separated by space. The new spell will be 
 *                                      added after the entry of the first matching resref.
 *                      BEFORE resref   Will place the new spell directly before the spell given by \"resref\".
 *                                      You can list more than one resref, separated by space. The new spell will be 
 *                                      added before the entry of the first matching resref.
 *                      LAST            Will place the new spell after all existing cures.
 *                      FIRST           Will place the new spell before all existing cures.
 *                      AT value        Will place the new spell at the position given by the number \"value\".
 *                                      Use negative values to place the new spell relative to the last spell position 
 *                                      in reverse order.
 *                      (Default: FIRST)
 * RETURN index         Index of the added cure or the last matching index when overwriting cure entries.
 *                      Returns -1 if the spell could not be added or updated.
 * RETURN offset        Offset of the added cure or the last matching offset when overwriting cures.
 *                      Returns -1 if the spell could not be added or updated.
 */
DEFINE_PATCH_FUNCTION ~ADD_STORE_CURE~
INT_VAR
  price       = 0
  overwrite   = 0
STR_VAR
  spell_name  = ~~
  position    = ~FIRST~
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~ADD_STORE_CURE~
  RET
    failed
    HEADER_SIZE = header_size
    SALE_SIZE = sale_size
    DRINK_SIZE = drink_size
    CURE_SIZE = cure_size
  END

  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x70 ofs_cures
    READ_LONG 0x74 num_cures

    PATCH_IF (num_cures = 0 && ofs_cures < HEADER_SIZE) BEGIN
      // Default order of sections: Drinks < Sales < Cures < Purchases
      READ_LONG 0x34 ofs  // sales
      PATCH_IF (ofs >= HEADER_SIZE) BEGIN
        READ_LONG 0x38 num
        SET size = SALE_SIZE
      END ELSE BEGIN
        READ_LONG 0x4c ofs  // drinks
        PATCH_IF (ofs >= HEADER_SIZE) BEGIN
          READ_LONG 0x50 num
          SET size = DRINK_SIZE
        END
      END

      PATCH_IF (ofs >= HEADER_SIZE) BEGIN
        SET ofs_cures = ofs + num * size
      END ELSE BEGIN
        SET ofs_cures = HEADER_SIZE
      END
      WRITE_LONG 0x70 ofs_cures
    END

    // Preparing arguments
    PATCH_IF (NOT ~%spell_name%~ STR_EQ ~~) BEGIN
      TO_UPPER ~spell_name~
    END ELSE BEGIN
      PATCH_WARN ~ADD_STORE_CURE: spell_name is empty.~
    END

    PATCH_IF (overwrite) BEGIN
      // Updating existing entries of matching cure strrefs
      FOR (idx = 0; idx < num_cures; ++idx) BEGIN
        SET ofs = ofs_cures + idx * CURE_SIZE
        READ_ASCII ofs resref
        PATCH_IF (~%resref%~ STR_EQ ~%spell_name%~) BEGIN
          WRITE_LONG (ofs + 0x08) price
          SET index = idx
          SET offset = ofs
        END
      END
    END

    PATCH_IF (index < 0) BEGIN
      SET found = 0
      FOR (idx = 0; idx < num_cures; ++idx) BEGIN
        READ_ASCII (ofs_cures + idx * CURE_SIZE) resref
        PATCH_IF (~%resref%~ STR_EQ ~%spell_name%~) BEGIN
          SET found = 1
          SET idx = num_cures
        END
      END

      PATCH_IF (NOT found) BEGIN
        // Adding new cure entry
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~Patching %spell_name%.SPL into store...~
        END  
        LPF ~__A7_EVAL_POSITION~
        INT_VAR
          num_entries = num_cures
          ofs_entries = ofs_cures
          size_entry  = CURE_SIZE
          ofs_resref  = 0
        STR_VAR
          position
          position_default  = ~FIRST~
          warn_prefix       = ~ADD_STORE_CURE~
        RET
          cure_position = entry_position
        END

        PATCH_IF (cure_position >= 0) BEGIN
          SET ofs = ofs_cures + cure_position * CURE_SIZE
          INSERT_BYTES ofs CURE_SIZE
          WRITE_ASCIIE ofs ~%spell_name%~ (8)
          WRITE_LONG (ofs + 0x08) price
          SET index = cure_position
          SET offset = ofs

          // Updating cure count and remaining offsets
          WRITE_LONG 0x74 (num_cures + 1)
          LPF ~__A7_UPDATE_OFFSETS~
          INT_VAR
            value = CURE_SIZE
            skip_offset = 0x70
          END
        END ELSE BEGIN
          PATCH_WARN ~ADD_STORE_CURE: Could not determine cure position.  Skipping...~
        END
      END ELSE BEGIN
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~%spell_name%.SPL is already in the store.  Skipping...~
        END  
      END
    END
  END
END


/**
 * Adds one or more item categories the store will buy to the current STO file. Existing categories will be skipped.
 * This is a PATCH function.
 * SET category     The item category to add.
 *                  A nearly complete list of supported item category codes can be found here:
 *                  https://gibberlings3.github.io/iesdp/file_formats/ie_formats/sto_v1.htm#tableItemType
 * RETURN index     Index of the added purchase. Returns -1 if the purchase could not be added.
 * RETURN offset    Offset of the added purchase. Returns -1 if the purchase could not be added.
 */
DEFINE_PATCH_FUNCTION ~ADD_STORE_PURCHASE~
INT_VAR
  category  = \"-1\"
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~ADD_STORE_PURCHASE~
  RET
    failed
    HEADER_SIZE = header_size
    SALE_SIZE = sale_size
    DRINK_SIZE = drink_size
    CURE_SIZE = cure_size
    PURCHASE_SIZE = purchase_size
  END

  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x2c ofs_purchases
    READ_LONG 0x30 num_purchases

    PATCH_IF (num_purchases = 0 && ofs_purchases < HEADER_SIZE) BEGIN
      // Default order of sections: Drinks < Sales < Cures < Purchases
      READ_LONG 0x70 ofs  // cures
      PATCH_IF (ofs >= HEADER_SIZE) BEGIN
        READ_LONG 0x74 num
        SET size = CURE_SIZE
      END ELSE BEGIN
        READ_LONG 0x34 ofs  // sales
        PATCH_IF (ofs >= HEADER_SIZE) BEGIN
          READ_LONG 0x38 num
          SET size = SALE_SIZE
        END ELSE BEGIN
          READ_LONG 0x4c ofs  // drinks
          PATCH_IF (ofs >= HEADER_SIZE) BEGIN
            READ_LONG 0x50 num
            SET size = DRINK_SIZE
          END
        END
      END

      PATCH_IF (ofs >= HEADER_SIZE) BEGIN
        SET ofs_purchases = ofs + num * size
      END ELSE BEGIN
        SET ofs_purchases = HEADER_SIZE
      END
      WRITE_LONG 0x2c ofs_purchases
    END

    // Adding new purchases
    PATCH_IF (category >= 0) BEGIN
      // Checking for existing category
      SET index_found = \"-1\"
      FOR (idx = 0; idx < num_purchases; ++idx) BEGIN
        READ_LONG (ofs_purchases + idx * PURCHASE_SIZE) value
        PATCH_IF (value = category) BEGIN
          SET index_found = idx
          SET idx = num_purchases
        END
      END

      PATCH_IF (index_found < 0) BEGIN
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~Patching item category %category% into store...~
        END  
        SET ofs = ofs_purchases + num_purchases * PURCHASE_SIZE
        INSERT_BYTES ofs PURCHASE_SIZE
        WRITE_LONG ofs category
        SET index = num_purchases
        SET offset = ofs

        // Updating purchase count and remaining offsets
        WRITE_LONG 0x30 (num_purchases + 1)
        LPF ~__A7_UPDATE_OFFSETS~
        INT_VAR
          value = PURCHASE_SIZE
          skip_offset = 0x2c
        END
      END ELSE BEGIN
        PATCH_IF !IS_SILENT BEGIN 
          PATCH_PRINT ~ADD_STORE_PURCHASE: Item category is already in the store.  Skipping...~
        END  
      END
    END ELSE BEGIN
      PATCH_WARN ~ADD_STORE_PURCHASE: Invalid item category %category%.  Skipping...~
    END
  END
END


/**
 * Removes all sale instances matching the specified item name from the current STO file. This is a patch function.
 * SPRINT item_name     The resource name (resref) of the item to remove. Regular expression syntax is supported.
 * RETURN index         Returns the index of the first removed entry matching the item name, returns -1 otherwise.
 * RETURN offset        Returns the offset of the first removed entry matching the item name, returns -1 otherwise.
 */
DEFINE_PATCH_FUNCTION ~REMOVE_STORE_ITEM_EX~
STR_VAR
  item_name = ~~
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~REMOVE_STORE_ITEM_EX~
  RET
    failed
    SALE_SIZE = sale_size
  END

  // Removing sale entries
  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x38 num_sales
    PATCH_IF (num_sales > 0) BEGIN
      PATCH_IF (~%item_name%~ STR_EQ ~~) BEGIN
        PATCH_WARN ~REMOVE_STORE_ITEM_EX: item_name is empty.~
      END

      SET num = 0
      READ_LONG 0x34 ofs_sales
      FOR (idx = num_sales - 1; idx >= 0; --idx) BEGIN
        SET ofs = ofs_sales + idx * SALE_SIZE
        READ_ASCII ofs resref (8)
        PATCH_IF (~%resref%~ STRING_MATCHES_REGEXP ~%item_name%~ = 0) BEGIN
          DELETE_BYTES ofs SALE_SIZE
          SET num += 1
          SET index = idx
          SET offset = ofs
        END
      END

      PATCH_IF (num > 0) BEGIN
        WRITE_LONG 0x38 (num_sales - num)
        LPF ~__A7_UPDATE_OFFSETS~
        INT_VAR
          value = 0 - (SALE_SIZE * num)
          skip_offset = 0x34
        END
      END
    END
  END
END


/**
 * Removes all drink instances matching the specified drink name from the current STO file. This is a patch function.
 * SPRINT drink_name    Name of the drink to remove. The following syntax is supported:
 *                      Literal string          Example: Elminster\'s Choice Beer
 *                      Strref value            Example: #1234
 *                      Translation reference   Example: @1000
 *                      Note: Regular expression syntax is supported for literal strings.
 * RETURN index         Returns the index of the first removed entry matching the drink name, returns -1 otherwise.
 * RETURN offset        Returns the offset of the first removed entry matching the drink name, returns -1 otherwise.
 */
DEFINE_PATCH_FUNCTION ~REMOVE_STORE_DRINK~
STR_VAR
  drink_name  = ~~
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~REMOVE_STORE_ITEM_EX~
  RET
    failed
    DRINK_SIZE = drink_size
  END

  // Removing drink entries
  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x50 num_drinks
    PATCH_IF (num_drinks > 0) BEGIN
      // Evaluating drink name
      TEXT_SPRINT drink_string ~~
      PATCH_IF (~%drink_name%~ STRING_MATCHES_REGEXP ~#-?[0-9]+~ = 0) BEGIN
        INNER_PATCH_SAVE value ~%drink_name%~ BEGIN DELETE_BYTES 0 1 END
        GET_STRREF value drink_string
        LPF ~__A7_ESCAPE_REGEXP~ STR_VAR string = EVAL ~%drink_string%~ RET drink_string = literal END
      END ELSE PATCH_IF (~%drink_name%~ STRING_MATCHES_REGEXP ~@-?[0-9]+~ = 0) BEGIN
        INNER_PATCH_SAVE value ~%drink_name%~ BEGIN DELETE_BYTES 0 1 END
        SPRINT drink_string (AT value)
        LPF ~__A7_ESCAPE_REGEXP~ STR_VAR string = EVAL ~%drink_string%~ RET drink_string = literal END
      END ELSE BEGIN
        TEXT_SPRINT drink_string ~%drink_name%~
      END

      SET num = 0
      READ_LONG 0x4c ofs_drinks
      FOR (idx = num_drinks - 1; idx >= 0; --idx) BEGIN
        SET ofs = ofs_drinks + idx * DRINK_SIZE
        READ_STRREF (ofs + 0x08) string
        PATCH_IF (~%string%~ STRING_MATCHES_REGEXP ~%drink_string%~ = 0) BEGIN
          DELETE_BYTES ofs DRINK_SIZE
          SET num += 1
          SET index = idx
          SET offset = ofs
        END
      END

      PATCH_IF (num > 0) BEGIN
        WRITE_LONG 0x50 (num_drinks - num)
        LPF ~__A7_UPDATE_OFFSETS~
        INT_VAR
          value = 0 - (DRINK_SIZE * num)
          skip_offset = 0x4c
        END
      END
    END
  END
END


/**
 * Removes all cure instances matching the specified spell name from the current STO file. This is a patch function.
 * SPRINT spell_name    The resource name (resref) of the spell to remove. Regular expression syntax is supported.
 * RETURN index         Returns the index of the first removed entry matching the spell name, returns -1 otherwise.
 * RETURN offset        Returns the offset of the first removed entry matching the spell name, returns -1 otherwise.
 */
DEFINE_PATCH_FUNCTION ~REMOVE_STORE_CURE~
STR_VAR
  spell_name  = ~~
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~REMOVE_STORE_CURE~
  RET
    failed
    CURE_SIZE = cure_size
  END

  // Removing cure entries
  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x74 num_cures
    PATCH_IF (num_cures > 0) BEGIN
      PATCH_IF (~%spell_name%~ STR_EQ ~~) BEGIN
        PATCH_WARN ~REMOVE_STORE_CURE: spell_name is empty.~
      END

      SET num = 0
      READ_LONG 0x70 ofs_cures
      FOR (idx = num_cures - 1; idx >= 0; --idx) BEGIN
        SET ofs = ofs_cures + idx * CURE_SIZE
        READ_ASCII ofs resref (8)
        PATCH_IF (~%resref%~ STRING_MATCHES_REGEXP ~%spell_name%~ = 0) BEGIN
          DELETE_BYTES ofs CURE_SIZE
          SET num += 1
          SET index = idx
          SET offset = ofs
        END
      END

      PATCH_IF (num > 0) BEGIN
        WRITE_LONG 0x74 (num_cures - num)
        LPF ~__A7_UPDATE_OFFSETS~
        INT_VAR
          value = 0 - (CURE_SIZE * num)
          skip_offset = 0x70
        END
      END
    END
  END
END


/**
 * Removes the specified item category from the current STO file. This is a patch function.
 * SET category     The item category to remove.
 *                  A nearly complete list of supported item category codes can be found here:
 *                  https://gibberlings3.github.io/iesdp/file_formats/ie_formats/sto_v1.htm#tableItemType
 * RETURN index     Returns the index of the removed entry matching the category, returns -1 otherwise.
 * RETURN offset    Returns the offset of the removed entry matching the category, returns -1 otherwise.
 */
DEFINE_PATCH_FUNCTION ~REMOVE_STORE_PURCHASE~
INT_VAR
  category  = \"-1\"
RET
  index
  offset
BEGIN
  SET index = \"-1\"
  SET offset = \"-1\"

  // Initializations
  LPF ~__A7_VALIDATE_STORE~
  STR_VAR warn_prefix = ~REMOVE_STORE_PURCHASE~
  RET
    failed
    PURCHASE_SIZE = purchase_size
  END

  // Removing purchase entries
  PATCH_IF (NOT failed) BEGIN
    READ_LONG 0x30 num_purchases
    PATCH_IF (num_purchases > 0) BEGIN
      SET num = 0
      READ_LONG 0x2c ofs_purchases
      FOR (idx = num_purchases - 1; idx >= 0; --idx) BEGIN
        SET ofs = ofs_purchases + idx * PURCHASE_SIZE
        READ_LONG ofs value
        PATCH_IF (value = category) BEGIN
          DELETE_BYTES ofs PURCHASE_SIZE
          SET num += 1
          SET index = idx
          SET offset = ofs
        END
      END

      PATCH_IF (num > 0) BEGIN
        WRITE_LONG 0x30 (num_purchases - num)
        LPF ~__A7_UPDATE_OFFSETS~
        INT_VAR
          value = 0 - (PURCHASE_SIZE * num)
          skip_offset = 0x2c
        END
      END
    END
  END
END



// Used internally to validate generic store file structure
DEFINE_PATCH_FUNCTION ~__A7_VALIDATE_STORE~
STR_VAR
  warn_prefix = ~~
RET
  failed
  version     // 10 (V1.0), 11 (V1.1) or 90 (V9.0)
  header_size
  sale_size
  drink_size
  cure_size
  purchase_size
BEGIN
  SET failed = 0
  SET version = 0
  SET header_size = 0
  SET sale_size = 0
  SET drink_size = 20
  SET cure_size = 12
  SET purchase_size = 4

  READ_ASCII 0 sig (4)
  PATCH_IF (NOT ~%sig%~ STR_EQ ~STOR~) BEGIN
    SET failed = 1
    PATCH_WARN ~%warn_prefix%: Not a store file.  Skipping...~
  END

  PATCH_IF (NOT failed) BEGIN
    READ_ASCII 4 ver (4)
    SET failed = 1
    PATCH_MATCH ~%ver%~
    WITH
      ~V1.0~
      BEGIN
        SET failed = 0
        SET version = 10
        SET header_size = 156
        SET sale_size = 28
      END
      ~V1.1~
      BEGIN
        SET failed = 0
        SET version = 11
        SET header_size = 156
        SET sale_size = 88
      END
      ~V9.0~
      BEGIN
        SET failed = 0
        SET version = 90
        SET header_size = 240
        SET sale_size = 28
      END
      DEFAULT
    END
    PATCH_IF (failed) BEGIN
      PATCH_WARN ~%warn_prefix%: Unsupported store version \"%ver%\".  Skipping...~
    END
  END

  PATCH_IF (NOT failed && BUFFER_LENGTH < header_size) BEGIN
    SET failed = 1
    PATCH_WARN ~%warn_prefix%: Corrupt store file.  Skipping...~
  END
END


// Used internally to evaluate item flags.
DEFINE_PATCH_FUNCTION ~__A7_EVAL_ITEM_FLAGS~
STR_VAR
  flags       = ~~
  warn_prefix = ~~
RET
  value
BEGIN
  SET value = 0
  INNER_PATCH ~%flags%~ BEGIN
    SET len = BUFFER_LENGTH
    WHILE (len > 0) BEGIN
      // Parsing tokens separated by space or ampersand
      SET start = INDEX_BUFFER(\"[^& %TAB%]\")
      PATCH_IF (start >= 0) BEGIN
        SET end = INDEX_BUFFER(\"[& %TAB%]\" start)
        PATCH_IF (end >= 0) BEGIN
          READ_ASCII start token (end - start)
          DELETE_BYTES 0 (end + 1)
          SET len -= (end + 1)
        END ELSE BEGIN
          READ_ASCII start token (len - start)
          SET len = 0
        END
        PATCH_MATCH ~%token%~
        WITH
          ~none~          BEGIN END // no change
          ~identified~    BEGIN value |= BIT0 END
          ~unstealable~   BEGIN value |= BIT1 END
          ~stolen~        BEGIN value |= BIT2 END
          ~-?[0-9]+~
          ~-?0b[01]+~
          ~-?0o[0-7]+~
          ~-?0x[0-9a-f]+~ BEGIN value |= token END
          DEFAULT
            PATCH_WARN ~%warn_prefix%: Unrecognised flags constant \"%token%\".  Skipping...~
        END
      END ELSE BEGIN
        SET len = 0
      END
    END
  END
END


// Used internally to evaluate entry position.
// Supported: AFTER resref/strref, BEFORE resref/strref, LAST, FIRST, AT value
DEFINE_PATCH_FUNCTION ~__A7_EVAL_POSITION~
INT_VAR
  num_entries       = 0
  ofs_entries       = 0
  size_entry        = 0
  ofs_resref        = \"-1\"  // relative offset in structure, set to >= 0 to compare resrefs (BEFORE/AFTER)
  ofs_strref        = \"-1\"  // relative offset in structure, set to >= 0 to compare strrefs (BEFORE/AFTER)
STR_VAR
  position          = ~~    // the position definition
  position_default  = ~FIRST~
  warn_prefix       = ~~    // string to be prefixed when printing warning messages
RET
  entry_position             // returns -1 on error
BEGIN
  SET entry_position = \"-1\"
  SET pos_type = \"-1\"
  SET item_pos_arg = 0

  PATCH_MATCH ~%position%~
  WITH
    ~FIRST\\([ %TAB%]+.*\\)?~
    BEGIN
      SET entry_position = 0
    END
    ~LAST\\([ %TAB%]+.*\\)?~
    BEGIN
      SET entry_position = num_entries
    END
    ~AT[ %TAB%]+.+~
    BEGIN
      INNER_PATCH_SAVE item_pos_arg ~%position%~ BEGIN
        REPLACE_TEXTUALLY ~AT[ %TAB%]+\\(.+\\)~ ~\\1~
      END
      PATCH_IF (NOT IS_AN_INT ~item_pos_arg~) BEGIN
        PATCH_WARN ~%warn_prefix%: position \"%item_pos_arg%\" is not a number - defaulting to 0.~
        SET item_pos_arg = 0
      END ELSE PATCH_IF (item_pos_arg > num_entries) BEGIN
        PATCH_WARN ~%warn_prefix%: AT %item_pos_arg% out of range 0-%num_entries% - defaulting to %num_entries%.~
        SET item_pos_arg = num_entries
      END ELSE PATCH_IF (item_pos_arg < 0 - num_entries) BEGIN
        PATCH_WARN ~%warn_prefix%: AT %item_pos_arg% out of range -1 - -%num_entries% - defaulting to -%num_entries%.~
        SET item_pos_arg = 0
      END ELSE PATCH_IF (item_pos_arg < 0) BEGIN
        SET item_pos_arg = num_entries + item_pos_arg
      END
      SET entry_position = item_pos_arg
    END
    ~BEFORE[ %TAB%]+.+~
    BEGIN
      SET entry_position = 0
      SET pos_type = 0
      INNER_PATCH ~%position%~ BEGIN
        COUNT_2DA_COLS numCols
        SET item_pos_arg = numCols - 1
        FOR (idx = 0; idx < item_pos_arg; ++idx) BEGIN
          READ_2DA_ENTRY 0 (idx + 1) numCols EVAL ~item_pos_arg_%idx%~
        END
      END
    END
    ~AFTER[ %TAB%]+.+~
    BEGIN
      SET entry_position = num_entries
      SET pos_type = 1
      SET item_pos_arg = 0
      INNER_PATCH ~%position%~ BEGIN
        COUNT_2DA_COLS numCols
        SET item_pos_arg = numCols - 1
        FOR (idx = 0; idx < item_pos_arg; ++idx) BEGIN
          READ_2DA_ENTRY 0 (idx + 1) numCols EVAL ~item_pos_arg_%idx%~
        END
      END
    END
    DEFAULT
      PATCH_WARN ~%warn_prefix%: position not recognised \"%position%\" - defaulting to \"%position_default%\".~
      LPF ~__A7_EVAL_POSITION~
        INT_VAR num_entries ofs_entries size_entry
        STR_VAR position = EVAL ~%position_default%~ warn_prefix
        RET entry_position
      END
    END

  // Find BEFORE/AFTER match
  PATCH_IF (pos_type >= 0 && (ofs_resref >= 0 || ofs_strref >= 0)) BEGIN
    FOR (idx = 0; idx < num_entries; ++idx) BEGIN
      PATCH_IF (ofs_resref >= 0) BEGIN
        READ_ASCII (ofs_entries + idx * size_entry + ofs_resref) resref_cmp (8) NULL
      END ELSE PATCH_IF (ofs_strref >= 0) BEGIN
        READ_LONG (ofs_entries + idx * size_entry + ofs_strref) strref_cmp
      END

      FOR (idx2 = 0; idx2 < item_pos_arg; ++idx2) BEGIN
        TEXT_SPRINT arg EVAL ~%item_pos_arg_%idx2%%~
        PATCH_IF (ofs_resref >= 0) BEGIN
          PATCH_IF (~%resref_cmp%~ STR_EQ ~%arg%~) BEGIN
            SET entry_position = idx + pos_type
            SET idx2 = item_pos_arg
            SET idx = num_entries
          END
        END ELSE PATCH_IF (ofs_strref >= 0) BEGIN
          LPF ~__A7_RESOLVE_STRREF~ STR_VAR string = EVAL ~%arg%~ RET strref END
          PATCH_IF (strref_cmp >= 0 && strref_cmp = strref) BEGIN
            SET entry_position = idx + pos_type
            SET idx2 = item_pos_arg
            SET idx = num_entries
          END
        END
      END
    END
  END
END


// Used internally to convert various string definitions into strref values.
DEFINE_PATCH_FUNCTION ~__A7_RESOLVE_STRREF~
STR_VAR string = ~~
RET strref
BEGIN
  PATCH_IF (~%string%~ STRING_MATCHES_REGEXP ~#-?[0-9]+~ = 0) BEGIN
    // Strref
    INNER_PATCH_SAVE string ~%string%~ BEGIN DELETE_BYTES 0 1 END
    SET strref = string
  END ELSE PATCH_IF (~%string%~ STRING_MATCHES_REGEXP ~@-?[0-9]+~ = 0) BEGIN
    // Tra reference
    INNER_PATCH_SAVE string ~%string%~ BEGIN DELETE_BYTES 0 1 END
    SET strref = RESOLVE_STR_REF( (AT string) )
  END ELSE BEGIN
    // Literal string
    SET strref = RESOLVE_STR_REF(~%string%~)
  END
END


// Used internally to update STO offsets by a specific amount
DEFINE_PATCH_FUNCTION ~__A7_UPDATE_OFFSETS~
INT_VAR
  value       = 0 // the value to add (can be negative)
  skip_offset = 0 // this offset is not updated
BEGIN
  READ_LONG skip_offset ofs_limit
  PATCH_FOR_EACH ofs IN 0x2c 0x34 0x4c 0x70 BEGIN
    PATCH_IF (ofs != skip_offset) BEGIN
      READ_LONG ofs base_value
      PATCH_IF (base_value >= ofs_limit) BEGIN
        WRITE_LONG ofs (base_value + value)
      END
    END
  END
END


// Used internally to escape special regular expression symbols
DEFINE_PATCH_FUNCTION ~__A7_ESCAPE_REGEXP~
STR_VAR
  string = ~~
RET
  literal
BEGIN
  SET escape = 0x5c  // ascii code of backslash character
  INNER_PATCH_SAVE literal ~%string%~ BEGIN
    FOR (pos = BUFFER_LENGTH - 1; pos >= 0; --pos) BEGIN
      READ_BYTE pos char
      PATCH_FOR_EACH value IN 0x24 0x2a 0x2b 0x2e 0x3f 0x5b 0x5c 0x5d 0x5e BEGIN  // check for $*+.?[\\]^
        PATCH_IF (char = value) BEGIN
          INSERT_BYTES pos 1
          WRITE_BYTE pos escape
        END
      END
    END
  END
END
  ");
(".../WEIDU_NAMESPACE/tb#macros.tpa","DEFINE_PATCH_MACRO ~tb#factorial~ BEGIN
  LOCAL_SET tb#factorial_index = tb#factorial_index
  PATCH_IF !(tb#factorial_index = 1) THEN BEGIN
    tb#factorial_result *= tb#factorial_index
    tb#factorial_index -= 1
    LAUNCH_PATCH_MACRO ~tb#factorial~
  END
END

DEFINE_ACTION_MACRO ~tb#fix_file_size~ BEGIN
  LOCAL_SPRINT file ~~
  LOCAL_SPRINT old ~~
  LOCAL_SET i = 0
  ACTION_IF ! (FILE_EXISTS_IN_GAME ~tb#removedF%tb#fix_file_size_category%.txt~) THEN BEGIN
    <<<<<<<< tb#fix_file_size_base.txt

    >>>>>>>>
    COPY ~tb#fix_file_size_base.txt~ ~override/tb#removedF%tb#fix_file_size_category%.txt~
    COPY_EXISTING_REGEXP ~%tb#fix_file_size_regexp%~ ~override~
      PATCH_IF SOURCE_SIZE < %tb#fix_file_size_min% THEN BEGIN
        SPRINT file ~%SOURCE_FILE%~
        INNER_ACTION BEGIN
          APPEND ~tb#removedF%tb#fix_file_size_category%.txt~ ~%file%~
        END
      END
    BUT_ONLY

    COPY_EXISTING ~tb#removedF%tb#fix_file_size_category%.txt~ ~override~
      READ_2DA_ENTRIES_NOW tb#fix_file_size_list 1
      FOR (i = 0; i < tb#fix_file_size_list; i+= 1) BEGIN
        READ_2DA_ENTRY_FORMER tb#fix_file_size_list i 0 old
        INNER_ACTION BEGIN
          COPY_EXISTING ~%tb#fix_file_size_target%~ ~override/%old%~
        END
      END
    BUT_ONLY
  END
END
  ");
(".../WEIDU_NAMESPACE/tb#tob_hacks.tpa","OUTER_SET tb#music_count = 4

OUTER_SET tb#music_address_1 = 0x000cc6f7
OUTER_PATCH_SAVE tb#music_patch_bytes_1 ~~ BEGIN
    INSERT_BYTES 0x000 0x42
    WRITE_LONG   0x000 0x8bfc4589
    WRITE_LONG   0x004 0xb773cc15
    WRITE_LONG   0x008 0xfc828b00
    WRITE_LONG   0x00c 0x89000004
    WRITE_LONG   0x010 0x4d8ba845
    WRITE_LONG   0x014 0xf44d89a8
    WRITE_LONG   0x018 0xfc55bf0f
    WRITE_LONG   0x01c 0xf445bf0f
    WRITE_LONG   0x020 0x5174d03b
    WRITE_LONG   0x024 0xc7a44d8b
    WRITE_LONG   0x028 0x0008c681
    WRITE_LONG   0x02c 0x00000000
    WRITE_LONG   0x030 0xa4558b00
    WRITE_LONG   0x034 0x08ca82c7
    WRITE_LONG   0x038 0x00500000
    WRITE_LONG   0x03c 0xbf0f0000
    WRITE_SHORT  0x040 0xf445
END

OUTER_SET tb#music_address_2 = 0x000d40ef
OUTER_PATCH_SAVE tb#music_patch_bytes_2 ~~ BEGIN
    INSERT_BYTES 0x000 0x611
    WRITE_LONG   0x000 0x00ffffbb
    WRITE_LONG   0x004 0x01003d00
    WRITE_LONG   0x008 0x2a7f0000
    WRITE_LONG   0x00c 0xff64bd81
    WRITE_LONG   0x010 0x0100ffff
    WRITE_LONG   0x014 0x840f0000
    WRITE_LONG   0x018 0x000000c9
    WRITE_LONG   0x01c 0xff64bd83
    WRITE_LONG   0x020 0x0f09ffff
    WRITE_LONG   0x024 0x0001aa87
    WRITE_LONG   0x028 0x648d8b00
    WRITE_LONG   0x02c 0xffffffff
    WRITE_LONG   0x030 0x47068d24
    WRITE_LONG   0x034 0x98e9004d
    WRITE_LONG   0x038 0x8b000001
    WRITE_LONG   0x03c 0xffff6895
    WRITE_LONG   0x040 0x50428bff
    WRITE_LONG   0x044 0xe9fc4589
    WRITE_LONG   0x048 0x0000018b
    WRITE_LONG   0x04c 0xff688d8b
    WRITE_LONG   0x050 0x518bffff
    WRITE_LONG   0x054 0xfc558954
    WRITE_LONG   0x058 0x00017ae9
    WRITE_LONG   0x05c 0x68858b00
    WRITE_LONG   0x060 0x8bffffff
    WRITE_LONG   0x064 0x4d895848
    WRITE_LONG   0x068 0x0169e9fc
    WRITE_LONG   0x06c 0x958b0000
    WRITE_LONG   0x070 0xffffff68
    WRITE_LONG   0x074 0x895c428b
    WRITE_LONG   0x078 0x58e9fc45
    WRITE_LONG   0x07c 0x8b000001
    WRITE_LONG   0x080 0xffff688d
    WRITE_LONG   0x084 0x60518bff
    WRITE_LONG   0x088 0xe9fc5589
    WRITE_LONG   0x08c 0x00000147
    WRITE_LONG   0x090 0xff68858b
    WRITE_LONG   0x094 0x488bffff
    WRITE_LONG   0x098 0xfc4d8964
    WRITE_LONG   0x09c 0x000136e9
    WRITE_LONG   0x0a0 0x68958b00
    WRITE_LONG   0x0a4 0x8bffffff
    WRITE_LONG   0x0a8 0x45896842
    WRITE_LONG   0x0ac 0x0125e9fc
    WRITE_LONG   0x0b0 0x8d8b0000
    WRITE_LONG   0x0b4 0xffffff68
    WRITE_LONG   0x0b8 0x896c518b
    WRITE_LONG   0x0bc 0x14e9fc55
    WRITE_LONG   0x0c0 0x8b000001
    WRITE_LONG   0x0c4 0xffff6885
    WRITE_LONG   0x0c8 0x70488bff
    WRITE_LONG   0x0cc 0xe9fc4d89
    WRITE_LONG   0x0d0 0x00000103
    WRITE_LONG   0x0d4 0xff68958b
    WRITE_LONG   0x0d8 0x428bffff
    WRITE_LONG   0x0dc 0xfc458974
    WRITE_LONG   0x0e0 0x0000f2e9
    WRITE_LONG   0x0e4 0xcc0d8b00
    WRITE_LONG   0x0e8 0x8b00b773
    WRITE_LONG   0x0ec 0x0042ba91
    WRITE_LONG   0x0f0 0xf8558900
    WRITE_LONG   0x0f4 0x05f8458b
    WRITE_LONG   0x0f8 0x00001dd0
    WRITE_LONG   0x0fc 0x8bf44589
    WRITE_LONG   0x100 0x018bf44d
    WRITE_LONG   0x104 0x35f7d233
    WRITE_LONG   0x108 0x00aaccd8
    WRITE_LONG   0x10c 0xccec153b
    WRITE_LONG   0x110 0x217200aa
    WRITE_LONG   0x114 0x8bf4558b
    WRITE_LONG   0x118 0xf7d23302
    WRITE_LONG   0x11c 0xaaccd835
    WRITE_LONG   0x120 0xf4153b00
    WRITE_LONG   0x124 0x7300aacc
    WRITE_LONG   0x128 0x6085c70c
    WRITE_LONG   0x12c 0x01ffffff
    WRITE_LONG   0x130 0xeb000000
    WRITE_LONG   0x134 0x6085c70a
    WRITE_LONG   0x138 0x00ffffff
    WRITE_LONG   0x13c 0x8b000000
    WRITE_LONG   0x140 0xffff6085
    WRITE_LONG   0x144 0x00ff25ff
    WRITE_LONG   0x148 0xc0850000
    WRITE_LONG   0x14c 0x0d8b6975
    WRITE_LONG   0x150 0x00b773cc
    WRITE_LONG   0x154 0x42ba918b
    WRITE_LONG   0x158 0x55890000
    WRITE_LONG   0x15c 0xf0458bf0
    WRITE_LONG   0x160 0x001dd005
    WRITE_LONG   0x164 0xec458900
    WRITE_LONG   0x168 0x8bec4d8b
    WRITE_LONG   0x16c 0xf7d23301
    WRITE_LONG   0x170 0xaaccd835
    WRITE_LONG   0x174 0xf4153b00
    WRITE_LONG   0x178 0x7200aacc
    WRITE_LONG   0x17c 0xec558b21
    WRITE_LONG   0x180 0xd233028b
    WRITE_LONG   0x184 0xccd835f7
    WRITE_LONG   0x188 0x153b00aa
    WRITE_LONG   0x18c 0x00aaccfc
    WRITE_LONG   0x190 0x85c70c73
    WRITE_LONG   0x194 0xffffff5c
    WRITE_LONG   0x198 0x00000001
    WRITE_LONG   0x19c 0x85c70aeb
    WRITE_LONG   0x1a0 0xffffff5c
    WRITE_LONG   0x1a4 0x00000000
    WRITE_LONG   0x1a8 0xff5c858b
    WRITE_LONG   0x1ac 0xff25ffff
    WRITE_LONG   0x1b0 0x85000000
    WRITE_LONG   0x1b4 0x8b0e74c0
    WRITE_LONG   0x1b8 0xffff688d
    WRITE_LONG   0x1bc 0x50518bff
    WRITE_LONG   0x1c0 0xebfc5589
    WRITE_LONG   0x1c4 0x68858b0c
    WRITE_LONG   0x1c8 0x8bffffff
    WRITE_LONG   0x1cc 0x4d895448
    WRITE_LONG   0x1d0 0x8904ebfc
    WRITE_LONG   0x1d4 0x0f90fc5d
    WRITE_LONG   0x1d8 0x83fc55bf
    WRITE_LONG   0x1dc 0x850ffefa
    WRITE_LONG   0x1e0 0x000000ef
    WRITE_LONG   0x1e4 0xb773cca1
    WRITE_LONG   0x1e8 0xba888b00
    WRITE_LONG   0x1ec 0x89000042
    WRITE_LONG   0x1f0 0x558be84d
    WRITE_LONG   0x1f4 0xd0c281e8
    WRITE_LONG   0x1f8 0x8900001d
    WRITE_LONG   0x1fc 0x458be455
    WRITE_LONG   0x200 0x33008be4
    WRITE_LONG   0x204 0xd835f7d2
    WRITE_LONG   0x208 0x3b00aacc
    WRITE_LONG   0x20c 0xaaccec15
    WRITE_LONG   0x210 0x8b217200
    WRITE_LONG   0x214 0x018be44d
    WRITE_LONG   0x218 0x35f7d233
    WRITE_LONG   0x21c 0x00aaccd8
    WRITE_LONG   0x220 0xccf4153b
    WRITE_LONG   0x224 0x0c7300aa
    WRITE_LONG   0x228 0xff5885c7
    WRITE_LONG   0x22c 0x0001ffff
    WRITE_LONG   0x230 0x0aeb0000
    WRITE_LONG   0x234 0xff5885c7
    WRITE_LONG   0x238 0x0000ffff
    WRITE_LONG   0x23c 0x958b0000
    WRITE_LONG   0x240 0xffffff58
    WRITE_LONG   0x244 0x00ffe281
    WRITE_LONG   0x248 0xd2850000
    WRITE_LONG   0x24c 0x858b0e74
    WRITE_LONG   0x250 0xffffff68
    WRITE_LONG   0x254 0x8950488b
    WRITE_LONG   0x258 0x77ebfc4d
    WRITE_LONG   0x25c 0x73cc158b
    WRITE_LONG   0x260 0x828b00b7
    WRITE_LONG   0x264 0x000042ba
    WRITE_LONG   0x268 0x8be04589
    WRITE_LONG   0x26c 0xc181e04d
    WRITE_LONG   0x270 0x00001dd0
    WRITE_LONG   0x274 0x8bdc4d89
    WRITE_LONG   0x278 0x028bdc55
    WRITE_LONG   0x27c 0x35f7d233
    WRITE_LONG   0x280 0x00aaccd8
    WRITE_LONG   0x284 0xccfc153b
    WRITE_LONG   0x288 0x217300aa
    WRITE_LONG   0x28c 0x8bdc458b
    WRITE_LONG   0x290 0xf7d23300
    WRITE_LONG   0x294 0xaaccd835
    WRITE_LONG   0x298 0xe4153b00
    WRITE_LONG   0x29c 0x7200aacc
    WRITE_LONG   0x2a0 0x5485c70c
    WRITE_LONG   0x2a4 0x00ffffff
    WRITE_LONG   0x2a8 0xeb000000
    WRITE_LONG   0x2ac 0x5485c70a
    WRITE_LONG   0x2b0 0x01ffffff
    WRITE_LONG   0x2b4 0x8b000000
    WRITE_LONG   0x2b8 0xffff548d
    WRITE_LONG   0x2bc 0xffe181ff
    WRITE_LONG   0x2c0 0x85000000
    WRITE_LONG   0x2c4 0x8b0c74c9
    WRITE_LONG   0x2c8 0xffff6895
    WRITE_LONG   0x2cc 0x54428bff
    WRITE_LONG   0x2d0 0x0ffc4589
    WRITE_LONG   0x2d4 0x83fc4dbf
    WRITE_LONG   0x2d8 0x850ffff9
    WRITE_LONG   0x2dc 0x00000322
    WRITE_LONG   0x2e0 0x0855bf0f
    WRITE_LONG   0x2e4 0xff509589
    WRITE_LONG   0x2e8 0xbd81ffff
    WRITE_LONG   0x2ec 0xffffff50
    WRITE_LONG   0x2f0 0x00000100
    WRITE_LONG   0x2f4 0xbd812a7f
    WRITE_LONG   0x2f8 0xffffff50
    WRITE_LONG   0x2fc 0x00000100
    WRITE_LONG   0x300 0x01b9840f
    WRITE_LONG   0x304 0xbd830000
    WRITE_LONG   0x308 0xffffff50
    WRITE_LONG   0x30c 0xeb870f09
    WRITE_LONG   0x310 0x8b000002
    WRITE_LONG   0x314 0xffff5085
    WRITE_LONG   0x318 0x8524ffff
    WRITE_LONG   0x31c 0x004d472e
    WRITE_LONG   0x320 0x0002d9e9
    WRITE_LONG   0x324 0xcc0d8b00
    WRITE_LONG   0x328 0x8b00b773
    WRITE_LONG   0x32c 0x0042ba91
    WRITE_LONG   0x330 0xd8558900
    WRITE_LONG   0x334 0x8bd8458b
    WRITE_LONG   0x338 0x0038e688
    WRITE_LONG   0x33c 0xd44d8900
    WRITE_LONG   0x340 0x8bd4558b
    WRITE_LONG   0x344 0x45895042
    WRITE_LONG   0x348 0x02b4e9fc
    WRITE_LONG   0x34c 0x0d8b0000
    WRITE_LONG   0x350 0x00b773cc
    WRITE_LONG   0x354 0x42ba918b
    WRITE_LONG   0x358 0x55890000
    WRITE_LONG   0x35c 0xd0458bd0
    WRITE_LONG   0x360 0x38e6888b
    WRITE_LONG   0x364 0x4d890000
    WRITE_LONG   0x368 0xcc558bcc
    WRITE_LONG   0x36c 0x8954428b
    WRITE_LONG   0x370 0x8be9fc45
    WRITE_LONG   0x374 0x8b000002
    WRITE_LONG   0x378 0xb773cc0d
    WRITE_LONG   0x37c 0xba918b00
    WRITE_LONG   0x380 0x89000042
    WRITE_LONG   0x384 0x458bc855
    WRITE_LONG   0x388 0xe6888bc8
    WRITE_LONG   0x38c 0x89000038
    WRITE_LONG   0x390 0x558bc44d
    WRITE_LONG   0x394 0x58428bc4
    WRITE_LONG   0x398 0xe9fc4589
    WRITE_LONG   0x39c 0x00000262
    WRITE_LONG   0x3a0 0x73cc0d8b
    WRITE_LONG   0x3a4 0x918b00b7
    WRITE_LONG   0x3a8 0x000042ba
    WRITE_LONG   0x3ac 0x8bc05589
    WRITE_LONG   0x3b0 0x888bc045
    WRITE_LONG   0x3b4 0x000038e6
    WRITE_LONG   0x3b8 0x8bbc4d89
    WRITE_LONG   0x3bc 0x428bbc55
    WRITE_LONG   0x3c0 0xfc45895c
    WRITE_LONG   0x3c4 0x000239e9
    WRITE_LONG   0x3c8 0xcc0d8b00
    WRITE_LONG   0x3cc 0x8b00b773
    WRITE_LONG   0x3d0 0x0042ba91
    WRITE_LONG   0x3d4 0xb8558900
    WRITE_LONG   0x3d8 0x8bb8458b
    WRITE_LONG   0x3dc 0x0038e688
    WRITE_LONG   0x3e0 0xb44d8900
    WRITE_LONG   0x3e4 0x8bb4558b
    WRITE_LONG   0x3e8 0x45896042
    WRITE_LONG   0x3ec 0x0210e9fc
    WRITE_LONG   0x3f0 0x0d8b0000
    WRITE_LONG   0x3f4 0x00b773cc
    WRITE_LONG   0x3f8 0x42ba918b
    WRITE_LONG   0x3fc 0x55890000
    WRITE_LONG   0x400 0xb0458bb0
    WRITE_LONG   0x404 0x38e6888b
    WRITE_LONG   0x408 0x4d890000
    WRITE_LONG   0x40c 0xac558bac
    WRITE_LONG   0x410 0x8964428b
    WRITE_LONG   0x414 0xe7e9fc45
    WRITE_LONG   0x418 0x8b000001
    WRITE_LONG   0x41c 0xb773cc0d
    WRITE_LONG   0x420 0xba918b00
    WRITE_LONG   0x424 0x89000042
    WRITE_LONG   0x428 0x458ba855
    WRITE_LONG   0x42c 0xe6888ba8
    WRITE_LONG   0x430 0x89000038
    WRITE_LONG   0x434 0x558ba44d
    WRITE_LONG   0x438 0x68428ba4
    WRITE_LONG   0x43c 0xe9fc4589
    WRITE_LONG   0x440 0x000001be
    WRITE_LONG   0x444 0x73cc0d8b
    WRITE_LONG   0x448 0x918b00b7
    WRITE_LONG   0x44c 0x000042ba
    WRITE_LONG   0x450 0x8ba05589
    WRITE_LONG   0x454 0x888ba045
    WRITE_LONG   0x458 0x000038e6
    WRITE_LONG   0x45c 0x8b9c4d89
    WRITE_LONG   0x460 0x428b9c55
    WRITE_LONG   0x464 0xfc45896c
    WRITE_LONG   0x468 0x000195e9
    WRITE_LONG   0x46c 0xcc0d8b00
    WRITE_LONG   0x470 0x8b00b773
    WRITE_LONG   0x474 0x0042ba91
    WRITE_LONG   0x478 0x98558900
    WRITE_LONG   0x47c 0x8b98458b
    WRITE_LONG   0x480 0x0038e688
    WRITE_LONG   0x484 0x944d8900
    WRITE_LONG   0x488 0x8b94558b
    WRITE_LONG   0x48c 0x45897042
    WRITE_LONG   0x490 0x016ce9fc
    WRITE_LONG   0x494 0x0d8b0000
    WRITE_LONG   0x498 0x00b773cc
    WRITE_LONG   0x49c 0x42ba918b
    WRITE_LONG   0x4a0 0x55890000
    WRITE_LONG   0x4a4 0x90458b90
    WRITE_LONG   0x4a8 0x38e6888b
    WRITE_LONG   0x4ac 0x4d890000
    WRITE_LONG   0x4b0 0x8c558b8c
    WRITE_LONG   0x4b4 0x8974428b
    WRITE_LONG   0x4b8 0x43e9fc45
    WRITE_LONG   0x4bc 0x8b000001
    WRITE_LONG   0x4c0 0xb773cc0d
    WRITE_LONG   0x4c4 0xba918b00
    WRITE_LONG   0x4c8 0x89000042
    WRITE_LONG   0x4cc 0x458b8855
    WRITE_LONG   0x4d0 0x1dd00588
    WRITE_LONG   0x4d4 0x45890000
    WRITE_LONG   0x4d8 0x844d8b84
    WRITE_LONG   0x4dc 0xd233018b
    WRITE_LONG   0x4e0 0xccd835f7
    WRITE_LONG   0x4e4 0x153b00aa
    WRITE_LONG   0x4e8 0x00aaccec
    WRITE_LONG   0x4ec 0x558b2172
    WRITE_LONG   0x4f0 0x33028b84
    WRITE_LONG   0x4f4 0xd835f7d2
    WRITE_LONG   0x4f8 0x3b00aacc
    WRITE_LONG   0x4fc 0xaaccf415
    WRITE_LONG   0x500 0xc70c7300
    WRITE_LONG   0x504 0xffff4c85
    WRITE_LONG   0x508 0x000001ff
    WRITE_LONG   0x50c 0xc70aeb00
    WRITE_LONG   0x510 0xffff4c85
    WRITE_LONG   0x514 0x000000ff
    WRITE_LONG   0x518 0x4c858b00
    WRITE_LONG   0x51c 0x25ffffff
    WRITE_LONG   0x520 0x000000ff
    WRITE_LONG   0x524 0x7275c085
    WRITE_LONG   0x528 0x73cc0d8b
    WRITE_LONG   0x52c 0x918b00b7
    WRITE_LONG   0x530 0x000042ba
    WRITE_LONG   0x534 0x8b805589
    WRITE_LONG   0x538 0xd0058045
    WRITE_LONG   0x53c 0x8900001d
    WRITE_LONG   0x540 0xffff7c85
    WRITE_LONG   0x544 0x7c8d8bff
    WRITE_LONG   0x548 0x8bffffff
    WRITE_LONG   0x54c 0xf7d23301
    WRITE_LONG   0x550 0xaaccd835
    WRITE_LONG   0x554 0xf4153b00
    WRITE_LONG   0x558 0x7200aacc
    WRITE_LONG   0x55c 0x7c958b24
    WRITE_LONG   0x560 0x8bffffff
    WRITE_LONG   0x564 0xf7d23302
    WRITE_LONG   0x568 0xaaccd835
    WRITE_LONG   0x56c 0xfc153b00
    WRITE_LONG   0x570 0x7300aacc
    WRITE_LONG   0x574 0x4885c70c
    WRITE_LONG   0x578 0x01ffffff
    WRITE_LONG   0x57c 0xeb000000
    WRITE_LONG   0x580 0x4885c70a
    WRITE_LONG   0x584 0x00ffffff
    WRITE_LONG   0x588 0x8b000000
    WRITE_LONG   0x58c 0xffff4885
    WRITE_LONG   0x590 0x00ff25ff
    WRITE_LONG   0x594 0xc0850000
    WRITE_LONG   0x598 0x0d8b3274
    WRITE_LONG   0x59c 0x00b773cc
    WRITE_LONG   0x5a0 0x42ba918b
    WRITE_LONG   0x5a4 0x95890000
    WRITE_LONG   0x5a8 0xffffff78
    WRITE_LONG   0x5ac 0xff78858b
    WRITE_LONG   0x5b0 0x888bffff
    WRITE_LONG   0x5b4 0x000038e6
    WRITE_LONG   0x5b8 0xff748d89
    WRITE_LONG   0x5bc 0x958bffff
    WRITE_LONG   0x5c0 0xffffff74
    WRITE_LONG   0x5c4 0x8950428b
    WRITE_LONG   0x5c8 0x30ebfc45
    WRITE_LONG   0x5cc 0x73cc0d8b
    WRITE_LONG   0x5d0 0x918b00b7
    WRITE_LONG   0x5d4 0x000042ba
    WRITE_LONG   0x5d8 0xff709589
    WRITE_LONG   0x5dc 0x858bffff
    WRITE_LONG   0x5e0 0xffffff70
    WRITE_LONG   0x5e4 0x38e6888b
    WRITE_LONG   0x5e8 0x8d890000
    WRITE_LONG   0x5ec 0xffffff6c
    WRITE_LONG   0x5f0 0xff6c958b
    WRITE_LONG   0x5f4 0x428bffff
    WRITE_LONG   0x5f8 0xfc458954
    WRITE_LONG   0x5fc 0x5d8904eb
    WRITE_LONG   0x600 0xbf0f90fc
    WRITE_LONG   0x604 0xc985fc4d
    WRITE_LONG   0x608 0x5d890475
    WRITE_LONG   0x60c 0x458b90fc
    WRITE_BYTE   0x610 0xfc
END

OUTER_SET tb#music_address_3 = 0x000d4892
OUTER_PATCH_SAVE tb#music_patch_bytes_3 ~~ BEGIN
    INSERT_BYTES 0x000 0x10
    WRITE_LONG   0x000 0x8af84589
    WRITE_LONG   0x004 0x8b51fc4d
    WRITE_LONG   0x008 0x0f520c55
    WRITE_LONG   0x00c 0x50f845bf
END

OUTER_SET tb#music_address_4 = 0x005e20b4
OUTER_PATCH_SAVE tb#music_patch_bytes_4 ~~ BEGIN
    INSERT_BYTES 0x000 0x19c
    WRITE_LONG   0x000 0x000203bc
    WRITE_LONG   0x004 0x057203e8
    WRITE_LONG   0x008 0x388d8900
    WRITE_LONG   0x00c 0x8bfffdfc
    WRITE_LONG   0x010 0xfdfc3885
    WRITE_LONG   0x014 0x34b883ff
    WRITE_LONG   0x018 0x00000001
    WRITE_LONG   0x01c 0xc0330775
    WRITE_LONG   0x020 0x000177e9
    WRITE_LONG   0x024 0x388d8b00
    WRITE_LONG   0x028 0x83fffdfc
    WRITE_LONG   0x02c 0x00013cb9
    WRITE_LONG   0x030 0x19740000
    WRITE_LONG   0x034 0x2068006a
    WRITE_LONG   0x038 0x6800b66b
    WRITE_LONG   0x03c 0x00b66b34
    WRITE_LONG   0x040 0x00132868
    WRITE_LONG   0x044 0xcf6ee800
    WRITE_LONG   0x048 0xc483fffb
    WRITE_LONG   0x04c 0x087d8310
    WRITE_LONG   0x050 0x83067e00
    WRITE_LONG   0x054 0xeb64087d
    WRITE_LONG   0x058 0x68006a19
    WRITE_LONG   0x05c 0x00b66b50
    WRITE_LONG   0x060 0xb66b8468
    WRITE_LONG   0x064 0x13296800
    WRITE_LONG   0x068 0x49e80000
    WRITE_LONG   0x06c 0x83fffbcf
    WRITE_LONG   0x070 0x006a10c4
    WRITE_LONG   0x074 0xfc388d8b
    WRITE_LONG   0x078 0xc181fffd
    WRITE_LONG   0x07c 0x00000130
    WRITE_LONG   0x080 0x06ebc4e8
    WRITE_LONG   0x084 0xf0458900
    WRITE_LONG   0x088 0x958b016a
    WRITE_LONG   0x08c 0xfffdfc38
    WRITE_LONG   0x090 0x520cc283
    WRITE_LONG   0x094 0x04108d8d
    WRITE_LONG   0x098 0x90e8fffe
    WRITE_LONG   0x09c 0xc7000555
    WRITE_LONG   0x0a0 0x0000fc45
    WRITE_LONG   0x0a4 0xa0680000
    WRITE_LONG   0x0a8 0x8b00b66b
    WRITE_LONG   0x0ac 0xe850f045
    WRITE_LONG   0x0b0 0x00033f90
    WRITE_LONG   0x0b4 0x6a08c483
    WRITE_LONG   0x0b8 0x388d8bff
    WRITE_LONG   0x0bc 0x81fffdfc
    WRITE_LONG   0x0c0 0x000130c1
    WRITE_LONG   0x0c4 0xebcee800
    WRITE_LONG   0x0c8 0x85c70006
    WRITE_LONG   0x0cc 0xfffe041c
    WRITE_LONG   0x0d0 0x00000000
    WRITE_LONG   0x0d4 0x8d8b0feb
    WRITE_LONG   0x0d8 0xfffe041c
    WRITE_LONG   0x0dc 0x8901c183
    WRITE_LONG   0x0e0 0xfe041c8d
    WRITE_LONG   0x0e4 0x1c958bff
    WRITE_LONG   0x0e8 0x3bfffe04
    WRITE_LONG   0x0ec 0x5d7d0855
    WRITE_LONG   0x0f0 0x041c858b
    WRITE_LONG   0x0f4 0xc069fffe
    WRITE_LONG   0x0f8 0x00000104
    WRITE_LONG   0x0fc 0x20058c8d
    WRITE_LONG   0x100 0x8bfffe04
    WRITE_LONG   0x104 0xfe041c95
    WRITE_LONG   0x108 0x958c89ff
    WRITE_LONG   0x10c 0xfffdfc40
    WRITE_LONG   0x110 0x041c858b
    WRITE_LONG   0x114 0x4d8bfffe
    WRITE_LONG   0x118 0x81148b0c
    WRITE_LONG   0x11c 0x38858b52
    WRITE_LONG   0x120 0x8bfffdfc
    WRITE_LONG   0x124 0x00013088
    WRITE_LONG   0x128 0xa4685100
    WRITE_LONG   0x12c 0x8b00b66b
    WRITE_LONG   0x130 0xfe041c95
    WRITE_LONG   0x134 0x04d269ff
    WRITE_LONG   0x138 0x8d000001
    WRITE_LONG   0x13c 0x04201584
    WRITE_LONG   0x140 0xe850fffe
    WRITE_LONG   0x144 0x000570f3
    WRITE_LONG   0x148 0xeb10c483
    WRITE_LONG   0x14c 0x084d8b89
    WRITE_LONG   0x150 0x40958d51
    WRITE_LONG   0x154 0x52fffdfc
    WRITE_LONG   0x158 0x0323c5e8
    WRITE_LONG   0x15c 0x08c48300
    WRITE_LONG   0x160 0x04108d8d
    WRITE_LONG   0x164 0x00e8fffe
    WRITE_LONG   0x168 0x8b000555
    WRITE_LONG   0x16c 0xfdfc3885
    WRITE_LONG   0x170 0x084d8bff
    WRITE_LONG   0x174 0x013c8889
    WRITE_LONG   0x178 0x85c70000
    WRITE_LONG   0x17c 0xfffdfc3c
    WRITE_LONG   0x180 0x00000001
    WRITE_LONG   0x184 0xfffc45c7
    WRITE_LONG   0x188 0x8dffffff
    WRITE_LONG   0x18c 0xfe04108d
    WRITE_LONG   0x190 0x54d5e8ff
    WRITE_LONG   0x194 0x858b0005
    WRITE_LONG   0x198 0xfffdfc3c
END
  ");
(".../WEIDU_NAMESPACE/worldmap_links.tpa","DEFINE_PATCH_FUNCTION fl#WORLDMAP_LINKS#PATCH_LINK
  INT_VAR
    link_offset = 0
    target_index = 0
    distance_scale = 0
    default_entry = 1
    encounter_probability = 0
  STR_VAR
    entry = \"\"
    random_area1 = \"\"
    random_area2 = \"\"
    random_area3 = \"\"
    random_area4 = \"\"
    random_area5 = \"\"
BEGIN
  PATCH_IF link_offset > 0 BEGIN
    WRITE_LONG   link_offset target_index
    WRITE_ASCIIE link_offset + 0x4  \"%entry%\" #32
    WRITE_LONG   link_offset + 0x24 distance_scale
    WRITE_LONG   link_offset + 0x28 default_entry
    WRITE_ASCIIE link_offset + 0x2c \"%random_area1%\" #8
    WRITE_ASCIIE link_offset + 0x34 \"%random_area2%\" #8
    WRITE_ASCIIE link_offset + 0x3c \"%random_area3%\" #8
    WRITE_ASCIIE link_offset + 0x44 \"%random_area4%\" #8
    WRITE_ASCIIE link_offset + 0x4c \"%random_area5%\" #8
    WRITE_LONG   link_offset + 0x54 encounter_probability
  END
END

DEFINE_PATCH_FUNCTION fl#WORLDMAP_LINKS#GET_SOURCE_NODE
  INT_VAR
    default = \"-1\"
  STR_VAR
    from_node = \"\"
  RET
    source_node
BEGIN
  source_node = default
  PATCH_MATCH \"%from_node%\" WITH
    \"north\" \"n\" BEGIN source_node = 0 END
    \"east\" \"e\" BEGIN source_node = 3 END
    \"south\" \"s\" BEGIN source_node = 2 END
    \"west\" \"w\" BEGIN source_node = 1 END
    \"\" BEGIN source_node = default END
    DEFAULT
      PATCH_WARN \"WARNING: ADD_WORLDMAP_LINKS got an illegal value for from_node (~%from_node%~); defaulting to all nodes\"
  END
END

DEFINE_PATCH_FUNCTION DELETE_WORLDMAP_LINKS
  STR_VAR
    from_area = \"\"
    from_node = \"\"
    to_area = \"\"
BEGIN
  fl#SOURCE_NODE_DEFAULT = \"-1\"
  LPF fl#WORLDMAP_LINKS#GET_SOURCE_NODE
    INT_VAR
      default = fl#SOURCE_NODE_DEFAULT
    STR_VAR
      from_node
    RET
      source_node
  END
  READ_LONG 0x34 ao
  READ_LONG 0x38 lo
  links = 0
  FOR (i = 0; i < LONG_AT 0x30; ++i) BEGIN
    lao = ao + 0xf0 * i
    READ_ASCII lao source_name
    PATCH_FOR_EACH node IN 0 3 2 1 BEGIN
      io = lao + 0x50 + 0x8 * node
      no = lao + 0x54 + 0x8 * node
      WRITE_LONG io links
      READ_LONG no number
      PATCH_IF \"%source_name%\" STRING_EQUAL_CASE \"%from_area%\" AND
               (source_node = node OR source_node = fl#SOURCE_NODE_DEFAULT)
      BEGIN
        FOR (j = 0; j < number; ++j) BEGIN
          llo = lo + 0xd8 * (links + j)
          READ_ASCII ao + 0xf0 * (LONG_AT llo) target_name
          PATCH_IF \"%target_name%\" STRING_EQUAL_CASE \"%to_area%\" BEGIN
            DELETE_BYTES llo 0xd8
            --number
            --j
          END
        END
      END
      WRITE_LONG no number
      links += number
    END
  END
  WRITE_LONG 0x3c links
END

DEFINE_PATCH_FUNCTION ADD_WORLDMAP_LINKS
  INT_VAR
    distance_scale = 0
    default_entry = 1
    encounter_probability = 0
  STR_VAR
    from_area = \"\"
    from_node = \"\"
    to_area = \"\"
    entry = \"\"
    random_area1 = \"\"
    random_area2 = \"\"
    random_area3 = \"\"
    random_area4 = \"\"
    random_area5 = \"\"
BEGIN
  fl#SOURCE_NODE_DEFAULT = \"-1\"
  LPF fl#WORLDMAP_LINKS#GET_SOURCE_NODE
    INT_VAR
      default = fl#SOURCE_NODE_DEFAULT
    STR_VAR
      from_node
    RET
      source_node
  END
  READ_LONG 0x30 na
  READ_LONG 0x34 ao
  READ_LONG 0x38 lo
  links = 0
  FOR (i = 0; i < na; ++i) BEGIN
    READ_ASCII ao + 0xf0 * i name
    TO_UPPER name
    SET $fl#ADD_WORLDMAP_LINKS#AREAS(\"%name%\") = i
  END
  TO_UPPER from_area
  TO_UPPER to_area
  PATCH_IF VARIABLE_IS_SET $fl#ADD_WORLDMAP_LINKS#AREAS(\"%from_area%\") AND
           VARIABLE_IS_SET $fl#ADD_WORLDMAP_LINKS#AREAS(\"%to_area%\")
  BEGIN
    FOR (i = 0; i < na; ++i) BEGIN
      lao = ao + 0xf0 * i
      READ_ASCII lao source_name
      PATCH_FOR_EACH node IN 0 3 2 1 BEGIN
        io = lao + 0x50 + 0x8 * node
        no = lao + 0x54 + 0x8 * node
        WRITE_LONG io links
        READ_LONG no number
        PATCH_IF \"%source_name%\" STRING_EQUAL_CASE \"%from_area%\" AND
                 (source_node = node OR source_node = fl#SOURCE_NODE_DEFAULT)
        BEGIN
          exists = 0
          FOR (j = 0; j < number; ++j) BEGIN
            llo = lo + 0xd8 * (links + j)
            READ_ASCII ao + 0xf0 * (LONG_AT llo) target_name
            PATCH_IF \"%target_name%\" STRING_EQUAL_CASE \"%to_area%\" BEGIN
              exists = llo
            END
          END
          PATCH_IF exists = 0 BEGIN
            llo = lo + 0xd8 * (links + number)
            INSERT_BYTES llo 0xd8
            LPF fl#WORLDMAP_LINKS#PATCH_LINK
              INT_VAR
                link_offset = llo
                target_index = $fl#ADD_WORLDMAP_LINKS#AREAS(\"%to_area%\")
                distance_scale
                default_entry
                encounter_probability
              STR_VAR
                entry
                random_area1
                random_area2
                random_area3
                random_area4
                random_area5
            END
            ++number
          END ELSE BEGIN
            LPF fl#WORLDMAP_LINKS#PATCH_LINK
              INT_VAR
                link_offset = exists
                target_index = $fl#ADD_WORLDMAP_LINKS#AREAS(\"%to_area%\")
                distance_scale
                default_entry
                encounter_probability
              STR_VAR
                entry
                random_area1
                random_area2
                random_area3
                random_area4
                random_area5
            END
          END
        END
        WRITE_LONG no number
        links += number
      END
    END
    WRITE_LONG 0x3c links
  END ELSE BEGIN
    PATCH_IF !VARIABLE_IS_SET $fl#ADD_WORLDMAP_LINKS#AREAS(\"%from_area%\") BEGIN
      PATCH_WARN \"WARNING: links from %from_area% were not added because %from_area% does not exist in the worldmap\"
    END ELSE
    PATCH_IF !VARIABLE_IS_SET $fl#ADD_WORLDMAP_LINKS#AREAS(\"%to_area%\") BEGIN
      PATCH_WARN \"WARNING: links to %to_area% were not added because %to_area% does not exist in the worldmap\"
    END
  END
END
  ");
]
let builtin_definitions = [	".../WEIDU_NAMESPACE/a7_pvrz.tpa";
	".../WEIDU_NAMESPACE/cd_functions.tpa";
	".../WEIDU_NAMESPACE/fj_are_struct.tpa";
	".../WEIDU_NAMESPACE/fj_cre_validity.tpa";
	".../WEIDU_NAMESPACE/fl_functions.tpa";
	".../WEIDU_NAMESPACE/get_unique_file_name.tpa";
	".../WEIDU_NAMESPACE/g_functions.tpa";
	".../WEIDU_NAMESPACE/g_macros.tpa";
	".../WEIDU_NAMESPACE/handle_audio.tpa";
	".../WEIDU_NAMESPACE/handle_charsets.tpa";
	".../WEIDU_NAMESPACE/handle_tilesets.tpa";
	".../WEIDU_NAMESPACE/res_of_spell_ids.tpa";
	".../WEIDU_NAMESPACE/sc#addwmpare.tpa";
	".../WEIDU_NAMESPACE/star_of_filespec.tpa";
	".../WEIDU_NAMESPACE/store_functions.tpa";
	".../WEIDU_NAMESPACE/tb#macros.tpa";
	".../WEIDU_NAMESPACE/tb#tob_hacks.tpa";
	".../WEIDU_NAMESPACE/worldmap_links.tpa";
]
