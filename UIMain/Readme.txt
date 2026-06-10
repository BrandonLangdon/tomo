This directory includes all file needed for Python based VAM slicer 
While once loaded the application is quick, loading can be quite slow

To build exe and dependencies you must be in a proper enviroment with all dependencies and run: 
pyinstaller file_Spec_File_Name.spec
	- Note: Spec file may need to be altered to run on your system in your environment
	- Front end must be built and placed into a folder named "frontend" in whatever folder holds backend python
	- Touchy