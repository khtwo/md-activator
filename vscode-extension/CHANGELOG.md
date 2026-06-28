# Changelog

## 0.1.4

- Update tab title when changing current viewing file
- treat non-typed ``` as ```text
- Add deletion on selected nodes and their connected edges
- Fix issue that edit box doesn't close when original value is "_" and value after edit is a empty string ""
- Replace empty title with "_" to avoid uneditable
- Move add node and add edge button to top level icon button
- Keep nodes selected status after moved
- Add multi-select and move
- Allow render empty maxGraph
- Fix mermaid render issue when load current page from new md file list
- Make new md file list confirmation check only check the last confirmatin checkbox to determine if it's confirmed.
- change delete function cursor and add delete undo history
- Make node auto resize with the node title
- Change new added node location to inside current view window
- Fix bugs in addin gnodes and edges
- Add maxGraph add node and edge function with undo
- Add --span <days> to specify the new file time span. Exclude the days that no md files are modified/created.
- Confirmation box include the button style confirmation box, eg [ ] [confirm]
- Classification markdown file should not include those confirm box which inside a text block.
- Add mark all viewed button
- Change the viewed log file to save absolute path, and put it to user home/.md-activator/...md
- List clarification files and new md files in merged list with order, where clarification files shows first
- Fix "fetch failed" error not hide when later fetch success
- Implement no change signal for new md file list refresh
- Exclude git ignored content in new md file list
- Add new md file notification and list for recent new created md files
- Add --open feature to launch server and send notification to windows 11 to open the url. Server auto down for 2 minutes inactive after first access
- Avoid showing broken image because of image path invalid
- Add YAML front-matter table rendering
- Fix the list item not start new line issue
- Add render content font size control
- Fix error not disappear after changing current page
- Add json/jsonl render
- Add renderer for yaml file format
- Allow edit titles in stategraph mermaid
- Move files list to top of file/folder list
- Add search function in vscode extension

## 0.1.3

- Add safety consideration
- Fix shrink/expand subfolder jump issue
- Fix shrink/expand folder jump issue
- Auto resize diagram view canvas according to the zoom in/out level
- Make renderer more tolerant for mermaid issues. Show friendly error message, and quick button.
- Add home, backward, forward button and function
- Tune file folder shrink/expand. Fix non blocked mermaid not editable defects.
- Make the file/folder drop down folders shrinkable
- Add edit title function for mermaid entity box and edge
- When url pointed file doesn't exist, jump to "/"
- Add zoom in/out and pan function for mermaid and maxgraph
- Split big files into small ones
- Connection point group align to middle and performance improvement
- Optimize maxgraph rendering performanc using Claude Code Opus 4.8 High
- Optimize re-render when drag and drop
- Improve render performance
- Fix link routing issues
- Fix the link cross entity block issue
- Fix link route choose left side with more bends instead of bottom side issue
- Improve link routing
- Fix route mess up when node is moved far
- Fix issue sometimes the link segment could be outside of canvas
- Put edge title to horizontal segment if have good clearance
- Allow more connection points on wide side
- Allow <mxfile> as the root node
- Add title changes into undo/redo history
- Enable edge title editing
- Fix uneven auto wrap of title of edge
- Enable startArrow and endArrow, with multiple style
- Enable support for endArrow=none
- Fix cell box title auto wrap too early/short
- Enable rendering \n in node box
- Change title editor to text area
- Enable editing on cell box text
- Set rounded to 1 in normal and color mode
- Add color support in maxGraphColor mode
- Fix link route cross after later connection points adjustment
- Change to auto render every 0.1 second during drag entity boxes
- Optimize performance
- Optimize the connection point location
- Fix the issue that some title alongside vertical segment have short width.
- Fix the issue long title not auto wrap in titles attached to vertical segment
- Adjust clearance between vertical segment title and other box or arrows
- Adjust maxGraph link title clearance
- Optimize link route by change link side
- Change minimal clearance between segments to 1.5 arrow width
- Optimal link route choice to have least cross
- The title attach to vertical segment is closer
- Make title for vertical segment closer. Add title for vertical segment have more clearance to adjacent horizontal segments.
- Enable auto render during drag entity box and move
- Trim maxGraph adapter bundle after build
- Add ctrl-z undo and ctrl-y redo for maxGraph node moves
- Add move entity location in maxGraph
- Make canvus width and height calculation consider link title position and size
- Adjust link title position
- Add display of link titles
- Optimize link in/out location
- Optimize link route selection
- Optimize link port side
- Ignore original port information and optimize link port location
- Fix link issue
- Fix line enter arrow from side
- Fix link render performance issue
- Fix some link overlapping issue
- Add render for right angle style
- Add vscode extension package
- Add maxGraph render
- Limit table width to not exceed wrapper width
- Adjust page wrapper max width to 15 in
- Add single choice options. Adjust page width
- Add single choice radio button
- Change light theme link color
- Refresh folder only when user click file/folder dropdown
- Adjust top bar structure

## 0.1.2

- Update extension repository metadata to the public `md-activator` repository.
- Refresh local VSIX install instructions for the `0.1.2` package.

## 0.1.0

- Add Markdown editor-title preview command.
- Launch bundled MD Activator server on a dynamic localhost port.
- Open rendered preview beside the active markdown editor.
- Add Marketplace package metadata and server runtime staging.
